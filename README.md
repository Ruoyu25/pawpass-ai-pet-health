# PawPass

PawPass is a local pet vaccination tracker. It keeps a separate vaccination card for each pet, turns booklet photos into editable drafts, and shows reminders for saved due dates. React, TypeScript and Vite power the interface. FastAPI serves the built app and stores records in SQLite.

## Install

Requires Python 3.11+, Node.js 20.19+ and npm. Run these commands from the PawPass folder.

```sh
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
npm --prefix frontend ci
cp .env.example .env
```

To enable photo extraction, set `GEMINI_API_KEY` in `.env` before starting the server. `GEMINI_MODEL` defaults to `gemini-3.8-flash` and can be set to an image-capable model that supports structured output. [Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key) · [Models](https://aistudio.google.com/docs/models)

## Start

```sh
npm --prefix frontend run build
python -m uvicorn app:app --app-dir backend --host 127.0.0.1 --port 8000
```

Open [PawPass](http://127.0.0.1:8000/). This build serves the frontend and API from one process. The app is designed for a single local workspace on loopback without user accounts. SQLite creates the database under `data/` by default. Set `PAWPASS_DB` to use another local path. Back up the database with SQLite’s backup command, or stop Uvicorn before copying the database file.

For the hackathon demo, start the server with `PAWPASS_DEMO=1` and open the [demo dashboard](http://127.0.0.1:8000/?workspace=demo). Demo data is fictional and uses its own SQLite file. Use **Switch to personal** to open the personal workspace.

### Development

Run the backend and Vite in separate terminals. Activate the Python environment in the backend terminal.

```sh
python -m uvicorn app:app --app-dir backend --host 127.0.0.1 --port 8000 --reload --reload-dir backend
```

```sh
npm --prefix frontend run dev
```

Open the Vite URL printed in the terminal. Vite proxies `/api` to port 8000. If you change the backend port, set `PAWPASS_API_URL` before starting Vite.

## Booklet scans and reminders

- Use **Scan booklet** to upload one JPEG, PNG or WebP page at a time, up to 8 MB and 24 megapixels. Confirm the pet and compare the draft with the source photo before saving. Unreadable and ambiguous values remain blank. You can edit or remove draft rows before saving the batch.
- PawPass sends a metadata-stripped copy of each scanned photo to Gemini. SQLite stores the records you save. If Gemini is unavailable or finds no readable entries, use **Enter manually**.
- Reminders are based on dates entered in saved records. Today through 30 days from today is upcoming, and dates before today are overdue. The most recent dose for each matching vaccine name on a pet controls the reminder. All doses remain in the vaccination history. Records without a due date do not trigger reminders.

## Tests

```sh
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s backend -v
npm --prefix frontend test
npm --prefix frontend run build
```

**Live Gemini extraction has not been verified.** Automated tests use temporary SQLite files and a mocked Gemini endpoint. Manual entry and record persistence were checked in the browser. The automated suite runs without an API key.

For local smoke tests and source ZIP checks, see the [PawPass verification skill](.agents/skills/verify-pawpass/SKILL.md).

## Assets

DM Sans and Fraunces are bundled under the SIL Open Font License. Their license texts are in `frontend/public/assets/`. The hero and three demo portraits in `frontend/public/images/` were generated with the built-in image generation tool from this prompt.

> Create one photorealistic editorial photography triptych asset for a polished pet health web dashboard. Strict 3 equal-width full-height vertical portrait panels side by side, with no gutter or borders, designed to be sliced exactly into equal thirds. Wide landscape aspect ratio 3:1 if possible. In the LEFT third, one happy reddish golden retriever with a teal fabric bandana, looking towards the camera with mouth slightly open, full head (ears intact) and chest, soft pale mint teal studio background. In the MIDDLE third, one beautiful orange tabby cat with white chin facing the camera, head and chest, warm pale sand studio background. In the RIGHT third, one adorable tricolor beagle with floppy ears, white stripe down face, head and chest, soft light blue-grey background. Center each face precisely within its own third horizontally and around 46% vertical height, generous breathing space, all three faces same visual scale. Natural realistic fur, premium pet editorial lighting, soft shadows, friendly warm feel. Clean solid pastel backgrounds without objects, no text or graphics. Distinct colors as specified. Precise equal thirds.
