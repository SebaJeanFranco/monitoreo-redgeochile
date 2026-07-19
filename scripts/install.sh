#!/usr/bin/env bash
# Instala la única dependencia Python que necesita fetch_alertas_dga.py --detalle.
# Uso: bash scripts/install.sh   (correr desde la carpeta centro-mando-app)
set -e
echo "Instalando 'requests' (necesario para --detalle)..."
pip install requests --break-system-packages
echo ""
echo "Listo. Ahora podés correr:"
echo "  python3 scripts/fetch_alertas_dga.py --out public/alertas-rios.json --detalle"
