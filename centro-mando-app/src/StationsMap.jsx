import { useMemo } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";

// ---------------------------------------------------------------------------
// Mapa GENERAL de estaciones DGA en alerta — puramente visual/referencial.
// No abre el detalle al hacer clic (eso vive en el mini-mapa dentro del
// modal de cada estación, ver StationMiniMap más abajo); el popup acá solo
// identifica la estación y su ubicación, nada más.
// ---------------------------------------------------------------------------

export const MARKER_COLORS = {
  Roja: "#E14B3D",
  Amarilla: "#E0A83E",
  Azul: "#3E8FD4",
};

// Centro aproximado de Chile continental, zoom que muestra el país completo.
const CHILE_CENTER = [-35.6, -71.5];
const CHILE_ZOOM = 5;

export default function StationsMap({ stations }) {
  // Solo estaciones con coordenadas válidas — algunas estaciones de la DGA
  // vienen sin latitud/longitud en el feed crudo.
  const withCoords = useMemo(
    () => stations.filter(s => s.latitud != null && s.longitud != null),
    [stations]
  );

  if (withCoords.length === 0) {
    return (
      <div className="rounded-xl border border-[#1B1F26] bg-[#12161C] px-5 py-10 text-center">
        <p className="text-sm text-[#5B6472]">Ninguna estación en alerta tiene coordenadas disponibles.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#1B1F26] overflow-hidden">
      <MapContainer
        center={CHILE_CENTER}
        zoom={CHILE_ZOOM}
        scrollWheelZoom={true}
        style={{ height: "520px", width: "100%", background: "#0B0D10" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {withCoords.map(station => (
          <CircleMarker
            key={station.codigo}
            center={[station.latitud, station.longitud]}
            radius={station.tipoAlerta === "Roja" ? 9 : 7}
            pathOptions={{
              color: MARKER_COLORS[station.tipoAlerta] || MARKER_COLORS.Azul,
              fillColor: MARKER_COLORS[station.tipoAlerta] || MARKER_COLORS.Azul,
              fillOpacity: 0.85,
              weight: station.tipoAlerta === "Roja" ? 3 : 2,
            }}
          >
            {/* Popup puramente informativo: nombre + comuna/región. Sin
                acciones — el mapa general es solo referencia visual. */}
            <Popup>
              <div style={{ fontFamily: "sans-serif", minWidth: "140px" }}>
                <strong>{station.nombre}</strong>
                <div style={{ fontSize: "12px", color: "#555", marginTop: "2px" }}>
                  {station.regionNombreAprox}
                </div>
              </div>
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}
