# Instala la unica dependencia Python que necesita fetch_alertas_dga.py --detalle.
# Uso (PowerShell): .\scripts\install.ps1   (correr desde la carpeta centro-mando-app)

Write-Host "Instalando 'requests' (necesario para --detalle)..."

pip install requests --break-system-packages
if ($LASTEXITCODE -ne 0) {
    Write-Host "El flag --break-system-packages no fue aceptado, reintentando sin el..."
    pip install requests
}

Write-Host ""
Write-Host "Listo. Ahora podes correr:"
Write-Host "  python scripts/fetch_alertas_dga.py --out public/alertas-rios.json --detalle"
