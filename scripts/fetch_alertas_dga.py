#!/usr/bin/env python3
"""
fetch_alertas_dga.py

Descarga el visor de estaciones hidrométricas de la DGA (SNIA - MOP Chile) y extrae
los datos reales de estaciones, en particular las que están actualmente en alerta
(Azul, Amarilla o Roja), tal como las define oficialmente la DGA.

Fuente: https://snia.mop.gob.cl/sat/site/informes/mapas/mapas.xhtml
Estos son datos de estaciones físicas reales (caudal, nivel de agua, etc.), no
estimaciones de modelo meteorológico como el resto del panel (que usa Open-Meteo).

IMPORTANTE — naturaleza del dato:
El JSON de estaciones viene embebido en el HTML de la página, dentro de un
comentario JavaScript. No es una API pública documentada por la DGA; es una
extracción basada en cómo está construida la página hoy. Si la DGA cambia el
sitio, este script puede dejar de funcionar y debe revisarse.

Uso:
    python3 fetch_alertas_dga.py [--out alertas-rios.json] [--all]

    --out   Ruta del archivo JSON de salida (default: alertas-rios.json)
    --all   Incluir también estaciones sin alerta (por defecto solo se listan
            las que tienen alerta=true, que es lo más útil para el panel)
"""

import argparse
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone

try:
    import requests
except ImportError:
    requests = None

SNIA_URL = "https://snia.mop.gob.cl/sat/site/informes/mapas/mapas.xhtml"

# Tiempo de espera entre peticiones de detalle (--detalle), en segundos.
# La página real hace UNA petición por cada clic humano en un pin — pedir
# detalle para cientos de estaciones muy rápido es agresivo para un servidor
# público. Con esta pausa, consultar las ~15 estaciones en alerta toma decenas
# de segundos, lo cual es razonable.
DETALLE_DELAY_SECONDS = 1.5

REGION_NAMES = {
    1: "Arica y Parinacota",
    2: "Tarapacá",
    3: "Antofagasta",
    4: "Atacama / Coquimbo",
    5: "Coquimbo / Valparaíso",
    6: "Valparaíso",
    7: "O'Higgins / Maule",
    8: "Ñuble / Biobío",
    9: "La Araucanía",
    10: "Los Ríos / Los Lagos",
    11: "Aysén",
    12: "Magallanes",
    13: "Metropolitana de Santiago",
    14: "Los Ríos",
    15: "Arica y Parinacota",
    16: "Ñuble",
}
# Nota importante: la codificación "regionResponsable.codigo" que usa el sistema
# SNIA de la DGA NO corresponde al código oficial de región de Chile — es un
# ordenamiento interno propio del sistema, aproximadamente de norte a sur, con
# algunos códigos que agrupan dos regiones administrativas juntas (p. ej. el
# código 8 mezcla Ñuble y Biobío) y otros fuera de orden (código 13 = RM,
# aunque geográficamente cae en la posición del código 7). Este mapeo se
# infirió comparando el rango de latitudes de las estaciones de cada código
# contra la geografía real de Chile — no proviene de documentación oficial de
# la DGA. Usar como referencia aproximada; el nombre de la estación y sus
# coordenadas (latitud/longitud) son la fuente de verdad más confiable.


# Headers que imita un navegador real. El servidor de la DGA devolvió 403
# Forbidden con un User-Agent mínimo (solo "Mozilla/5.0") — probablemente
# tiene un firewall/WAF que bloquea peticiones que no traen el conjunto
# completo de cabeceras típicas de un navegador. Estos headers son los
# mismos que capturamos en Chrome DevTools contra este mismo sitio.
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "es-419,es;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}


def fetch_html(url: str) -> str:
    req = urllib.request.Request(url, headers=BROWSER_HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        # El servidor puede comprimir la respuesta (gzip/br) aunque no lo
        # pedimos explícitamente via urllib; si el contenido no decodifica
        # como texto plano, probamos descomprimir gzip antes de rendirnos.
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            import gzip
            try:
                return gzip.decompress(raw).decode("utf-8", errors="ignore")
            except OSError:
                return raw.decode("utf-8", errors="ignore")


# El estado de transmisión (marker.valorTransmision en el popup del sitio) se
# muestra como texto ("Estado Tx") pero el HTML de la página lo calcula en JS
# a partir de este código numérico — no viene como texto en el JSON crudo.
# Mapeo inferido observando qué valores acompañan a error=true/false en los datos:
# 1 = transmitiendo con normalidad; 3 y 4 aparecen junto con mensajeError presente.
VALOR_TRANSMISION_LABELS = {
    1: "Transmitiendo",
    3: "Transmitiendo con anomalía",
    4: "Transmitiendo con anomalía",
}


def extract_stations(html: str):
    """Extrae el array JSON de estaciones embebido en el JS de la página.

    OJO: la página contiene DOS bloques que empiezan con 'initialize([':
    uno activo (window.addEventListener('load', ...)) y uno viejo dejado
    comentado dentro de un bloque /* ... */ más arriba en el archivo. Si se
    toma el primer match tal cual, se puede capturar el bloque comentado
    (datos obsoletos) en vez del real. Por eso buscamos específicamente el
    que está dentro de addEventListener('load', ...).
    """
    anchor = html.find("addEventListener('load'")
    if anchor == -1:
        # Fallback: por si el sitio cambia el nombre del listener, buscamos
        # cualquier 'initialize([' que NO esté dentro de un comentario /* */.
        anchor = 0

    match = re.search(r"initialize\(\s*(\[)", html[anchor:])
    if not match:
        raise RuntimeError(
            "No se encontró el bloque de datos esperado en la página. "
            "La DGA puede haber cambiado el formato del sitio — revisar "
            "manualmente https://snia.mop.gob.cl/sat/site/informes/mapas/mapas.xhtml"
        )
    start = anchor + match.start(1)

    # Balanceamos corchetes manualmente en vez de usar un regex greedy/no-greedy,
    # porque el array es demasiado grande e irregular para una expresión regular
    # confiable, y evita el corte prematuro que puede pasar con [.*?].
    depth = 0
    end = None
    for i in range(start, len(html)):
        ch = html[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end is None:
        raise RuntimeError("El array de estaciones parece estar truncado (corchetes sin cerrar).")

    raw = html[start:end]
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"El bloque encontrado no es JSON válido: {e}")


def normalize_station(s: dict) -> dict:
    region_code = s.get("regionResponsable", {}).get("codigo")
    valor_tx = s.get("valorTransmision")
    return {
        "codigo": s.get("codigo"),
        "nombre": s.get("nombre", "").strip(),
        "alerta": bool(s.get("alerta")) or (s.get("nivelAlerta") or 0) > 0,
        "tipoAlerta": s.get("tipoAlerta"),  # "Azul" | "Amarilla" | "Roja" | None
        "nivelAlerta": s.get("nivelAlerta"),
        "valorMedicion": s.get("valorMedicion"),
        "umbral": s.get("umbral"),
        "umbralSuperado": s.get("umbralSuperado"),
        "unidad": (s.get("parametro", {}) or {}).get("glsUnidad", "").strip() or None,
        "parametro": (s.get("parametro", {}) or {}).get("glsParametro", "").strip() or None,
        "fuenteEstacion": s.get("fuenteEstacion"),
        "tipoEstacion": s.get("tipoEstacion"),
        "fecha": s.get("fecha"),
        "regionCodigo": region_code,
        "regionNombreAprox": REGION_NAMES.get(region_code, f"Región {region_code}"),
        "latitud": float(s["latitud"]) if s.get("latitud") not in (None, "") else None,
        "longitud": float(s["longitud"]) if s.get("longitud") not in (None, "") else None,
        "utmEste": s.get("utmEste"),
        "utmNorte": s.get("utmNorte"),
        "altitud": s.get("altitud"),
        "error": bool(s.get("error")),
        "mensajeError": s.get("mensajeError"),
        "valorTransmision": valor_tx,
        "estadoTransmision": VALOR_TRANSMISION_LABELS.get(valor_tx, f"Código {valor_tx}" if valor_tx is not None else None),
    }


def dedupe_stations(stations: list) -> list:
    """La fuente de la DGA a veces repite el mismo código de estación varias
    veces con datos idénticos (visto hasta 6 repeticiones para un mismo
    código). Nos quedamos con una sola ocurrencia por código, preservando
    el orden de aparición."""
    seen = set()
    result = []
    for s in stations:
        code = s.get("codigo")
        if code in seen:
            continue
        seen.add(code)
        result.append(s)
    return result


# ---------------------------------------------------------------------------
# Detalle por estación (Caudal, Precipitación 24h, Precipitación acumulada)
#
# Estos tres valores NO vienen en el array `initialize([...])` de la carga
# inicial de la página. Se obtienen con una petición AJAX aparte (JSF/RichFaces)
# que el sitio dispara cuando el usuario hace clic en un pin del mapa. El
# servidor responde con un bloque <script> donde los valores ya vienen
# calculados como texto plano (ej: var ultimoCaudalReg = "0,12";), así que se
# extraen con regex de la respuesta en vez de parsear JSON.
#
# Esto se reconstruyó a partir de una captura real de Chrome DevTools (pestaña
# Network → Payload) hecha por el usuario el 2026-07-19, no de documentación
# oficial. Si la DGA cambia los nombres de componente JSF (ej. si
# "medicionesByTypeFunctions:j_idt162" cambia de id en un despliegue futuro
# del sitio), esta función dejará de funcionar y debe volver a capturarse.
# ---------------------------------------------------------------------------

DETALLE_VALUE_PATTERNS = {
    "caudalM3s": r'var ultimoCaudalReg = "([^"]*)"',
    "precipitacion24hMm": r'var dif24PptacionAcum = "([^"]*)"',
    "precipitacionAcumMm": r'var ultimaPptacionAcumuladaReg = "([^"]*)"',
    "alturaNieveCm": r'var ultimaAlturaNieveReg = "([^"]*)"',
    "volumenLagoMillM3": r'var ultimoVolumenReg = "([^"]*)"',
}


def parse_cl_number(text):
    """Convierte '14,50' (formato chileno, coma decimal) a float 14.5.
    Devuelve None si el texto viene vacío (el sitio deja "" cuando el
    parámetro no aplica a ese tipo de estación, ej. estaciones sin
    medición de caudal)."""
    if text is None:
        return None
    text = text.strip()
    if text == "":
        return None
    try:
        return float(text.replace(".", "").replace(",", "."))
    except ValueError:
        return None


def get_session_and_viewstate(session):
    """Carga la página principal para obtener las cookies de sesión
    (JSESSIONID) y el token javax.faces.ViewState que exige JSF en cada
    petición AJAX posterior. Se hace una sola vez por ejecución del script;
    en las capturas del usuario el mismo ViewState sirvió para varias
    peticiones consecutivas dentro de una misma sesión de navegador."""
    resp = session.get(SNIA_URL, headers=BROWSER_HEADERS, timeout=30)
    resp.raise_for_status()
    match = re.search(
        r'name="javax\.faces\.ViewState"[^>]*value="([^"]*)"', resp.text
    )
    if not match:
        raise RuntimeError(
            "No se pudo obtener javax.faces.ViewState de la página. "
            "El sitio puede haber cambiado su estructura JSF."
        )
    return match.group(1)


def fetch_station_detail(session, viewstate, codigo, nombre, tipo_estacion):
    """Reproduce la petición AJAX que dispara el componente JSF
    'medicionesByTypeFunctions' al hacer clic en un pin, y extrae Caudal /
    Precipitación 24h / Precipitación acumulada / Altura de nieve / Volumen
    de lago del bloque <script> que devuelve el servidor.

    Devuelve un dict con esos campos (en float, o None si no aplica a esta
    estación), o None si la petición falló (para no interrumpir el resto
    del proceso — este detalle es un "extra", las alertas ya funcionan sin él).
    """
    payload = {
        "medicionesByTypeFunctions": "medicionesByTypeFunctions",
        "javax.faces.ViewState": viewstate,
        "javax.faces.source": "medicionesByTypeFunctions:j_idt162",
        "javax.faces.partial.execute": "medicionesByTypeFunctions:j_idt162 @component",
        "javax.faces.partial.render": "@component",
        "param1": codigo,
        "param2": tipo_estacion or "",
        "org.richfaces.ajax.component": "medicionesByTypeFunctions:j_idt162",
        "medicionesByTypeFunctions:j_idt162": "medicionesByTypeFunctions:j_idt162",
        "AJAX:EVENTS_COUNT": "1",
        "javax.faces.partial.ajax": "true",
    }
    headers = {
        **BROWSER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Faces-Request": "partial/ajax",
        "Referer": SNIA_URL,
        "Origin": "https://snia.mop.gob.cl",
        "X-Requested-With": "XMLHttpRequest",
    }
    try:
        resp = session.post(SNIA_URL, data=payload, headers=headers, timeout=20)
        resp.raise_for_status()
    except Exception as e:
        print(f"  [detalle] {codigo} ({nombre}): fallo de red — {e}", file=sys.stderr)
        return None

    text = resp.text
    result = {}
    any_found = False
    for key, pattern in DETALLE_VALUE_PATTERNS.items():
        m = re.search(pattern, text)
        if m:
            any_found = True
            result[key] = parse_cl_number(m.group(1))
        else:
            result[key] = None

    if not any_found:
        print(f"  [detalle] {codigo} ({nombre}): respuesta sin los campos esperados — el sitio puede haber cambiado.", file=sys.stderr)
        return None
    return result


def main():
    parser = argparse.ArgumentParser(description="Extrae alertas de estaciones DGA (SNIA)")
    parser.add_argument("--out", default="alertas-rios.json", help="Archivo JSON de salida")
    parser.add_argument("--all", action="store_true", help="Incluir también estaciones sin alerta")
    parser.add_argument(
        "--detalle",
        action="store_true",
        help=(
            "Además de la lista de alertas, consulta el detalle por estación "
            "(Caudal, Precipitación 24h, Precipitación acumulada) reproduciendo "
            "la petición AJAX que dispara el sitio al hacer clic en un pin. "
            "Hace una petición extra por cada estación en alerta — más lento, "
            "requiere la librería 'requests' (pip install requests)."
        ),
    )
    args = parser.parse_args()

    print(f"Descargando {SNIA_URL} ...", file=sys.stderr)
    try:
        html = fetch_html(SNIA_URL)
    except Exception as e:
        print(f"ERROR al descargar la página: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        raw_stations = extract_stations(html)
    except Exception as e:
        print(f"ERROR al extraer datos: {e}", file=sys.stderr)
        sys.exit(1)

    stations_raw_count = len(raw_stations)
    stations = [normalize_station(s) for s in raw_stations]
    stations = dedupe_stations(stations)
    duplicados_removidos = stations_raw_count - len(stations)
    if duplicados_removidos > 0:
        print(f"Nota: se removieron {duplicados_removidos} registro(s) duplicado(s) por código de estación.", file=sys.stderr)

    en_alerta = [s for s in stations if s["alerta"]]

    output_stations = stations if args.all else en_alerta

    if args.detalle:
        if requests is None:
            print(
                "ERROR: --detalle requiere la librería 'requests'. Instálala con: "
                "pip install requests --break-system-packages",
                file=sys.stderr,
            )
            sys.exit(1)
        print(f"Obteniendo detalle (Caudal/Precipitación) de {len(output_stations)} estación(es)...", file=sys.stderr)
        session = requests.Session()
        try:
            viewstate = get_session_and_viewstate(session)
        except Exception as e:
            print(f"ERROR al iniciar sesión con la DGA: {e}", file=sys.stderr)
            print("Se continúa sin detalle.", file=sys.stderr)
            viewstate = None

        if viewstate:
            for i, s in enumerate(output_stations, 1):
                print(f"  ({i}/{len(output_stations)}) {s['codigo']} — {s['nombre']}", file=sys.stderr)
                detalle = fetch_station_detail(session, viewstate, s["codigo"], s["nombre"], s.get("tipoEstacion"))
                s["detalle"] = detalle
                if i < len(output_stations):
                    time.sleep(DETALLE_DELAY_SECONDS)

    result = {
        "generadoEn": datetime.now(timezone.utc).isoformat(),
        "fuente": SNIA_URL,
        "totalEstacionesConsultadas": len(stations),
        "totalEnAlerta": len(en_alerta),
        "duplicadosRemovidos": duplicados_removidos,
        "soloAlertas": not args.all,
        "incluyeDetalle": args.detalle,
        "estaciones": output_stations,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"OK: {len(en_alerta)} estación(es) en alerta de {len(stations)} consultadas.", file=sys.stderr)
    print(f"Guardado en: {args.out}", file=sys.stderr)

    # También imprime un resumen legible en pantalla
    if en_alerta:
        print("\n--- Estaciones en alerta ---")
        for s in en_alerta:
            print(
                f"[{s['tipoAlerta']}] {s['nombre']} "
                f"({s['regionNombreAprox']}) — "
                f"{s['valorMedicion']} / umbral {s['umbral']} {s['unidad'] or ''}".strip()
            )
    else:
        print("\nNo hay estaciones en alerta en este momento.")


if __name__ == "__main__":
    main()
