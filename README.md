# Rezeptbuch

Eigene Rezept-App: Rezepte aus Links, Fotos und Screenshots in einem einheitlichen Format, mobil lesbar und als A4-PDF.

Bei jedem Hochladen auf `main` baut GitHub automatisch das Image `ghcr.io/sampanzee/rezeptbuch-server:latest`. Watchtower spielt es nachts auf dem NAS ein.

## Portainer-Stack „rezeptbuch“

```yaml
services:
  rezeptbuch:
    image: ghcr.io/sampanzee/rezeptbuch-server:latest
    container_name: rezeptbuch
    restart: unless-stopped
    ports:
      - "8095:8080"
    volumes:
      - /volume1/docker/rezeptbuch/data:/data
    environment:
      - TZ=Europe/Berlin
      - USERS=${USERS}
      - AI_KEY=${AI_KEY}
      - AI_MODEL=openrouter/free
```

Umgebungsvariablen in Portainer: `USERS` (`Name:Passwort;Name2:Passwort2`) und `AI_KEY` (OpenRouter-Schlüssel).
