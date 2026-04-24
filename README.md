# HV-Wette

Wer tippt am nächsten, wann die Hauptversammlung endet?

## Setup

```bash
npm install
cp .env.example .env
# .env bearbeiten und ADMIN_PASSWORD setzen
npm start
```

## URLs

| URL | Beschreibung |
|-----|-------------|
| `http://localhost:3000` | Live-Ansicht (für Beamer/TV) |
| `http://localhost:3000/admin.html?pw=PASSWORT` | Admin-Backend |

## Spielprinzip

- Teilnehmer geben einen Tipp ab, wann die HV endet (HH:MM)
- Alle zahlen denselben Einsatz
- Führend ist immer, wer bei aktuellem Stand am nächsten dran wäre
- Bei HV-Ende gewinnt die Person mit der kleinsten Abweichung
- Gleichstand → Pott wird geteilt

## Datenhaltung

State wird in `data.json` persistiert (wird beim Start angelegt). Die Datei ist in `.gitignore` eingetragen.

## Entwicklung

```bash
npm run dev   # mit nodemon (auto-restart)
```
