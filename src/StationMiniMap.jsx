import { MapContainer, TileLayer, CircleMarker } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { MARKER_COLORS } from "./StationsMap.jsx";

// ---------------------------------------------------------------------------
// Mapa de UNA estación, para el modal de detalle. A diferencia del mapa
// general (StationsMap), este está centrado y con zoom sobre el punto
// exacto — responde a "¿dónde queda esto?" para esa estación puntual.
// ---------------------------------------------------------------------------

const STATION_ZOOM = 12;

export default function StationMiniMap({ station }) {
  if (station.latitud == null || station.longitud == null) {
    return (
      <div className="rounded-lg border border-[#1B1F26] bg-[#0B0D10] px-4 py-6 text-center">
        <p className="text-[12px] text-[#5B6472]">Sin coordenadas disponibles para esta estación.</p>
      </div>
    );
  }

  const color = MARKER_COLORS[station.tipoAlerta] || MARKER_COLORS.Azul;
  const center = [station.latitud, station.longitud];

  return (
    <div className="rounded-lg border border-[#1B1F26] overflow-hidden">
      <MapContainer
        center={center}
        zoom={STATION_ZOOM}
        scrollWheelZoom={false}
        dragging={true}
        style={{ height: "280px", width: "100%", background: "#0B0D10" }}
      >
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <CircleMarker
          center={center}
          radius={10}
          pathOptions={{ color, fillColor: color, fillOpacity: 0.9, weight: 3 }}
        />
      </MapContainer>
    </div>
  );
}
