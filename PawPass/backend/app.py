import os
import re
import sqlite3
from contextlib import asynccontextmanager, closing
from datetime import date, timedelta
from pathlib import Path
from typing import Annotated, Literal

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationInfo, field_validator
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from extraction import (
    FORMATS, MAX_UPLOAD, ExtractionUnavailable, InvalidImage, extract_records, prepare_image,
)

HERE = Path(__file__).resolve().parent
load_dotenv(HERE.parent / ".env")

SCHEMA = """
CREATE TABLE IF NOT EXISTS pets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    species TEXT NOT NULL CHECK (length(species) BETWEEN 1 AND 40),
    born_on TEXT NOT NULL,
    avatar TEXT
);
CREATE TABLE IF NOT EXISTS vaccinations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pet_id INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
    vaccine TEXT NOT NULL CHECK (length(vaccine) BETWEEN 1 AND 120),
    given_on TEXT NOT NULL,
    due_on TEXT CHECK (due_on IS NULL OR due_on >= given_on),
    clinic TEXT NOT NULL DEFAULT '',
    lot TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS vaccination_pet_date ON vaccinations(pet_id, given_on DESC, id DESC);
CREATE TABLE IF NOT EXISTS demo_initialized (id INTEGER PRIMARY KEY CHECK (id = 1));
"""


def connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path, timeout=5, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize(path: Path, demo: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect(path)) as db:
        db.execute("PRAGMA journal_mode = WAL")
        db.executescript(SCHEMA)
        if not demo:
            return
        with db:
            if not db.execute("INSERT OR IGNORE INTO demo_initialized VALUES (1)").rowcount:
                return
            today = date.today()

            def offset(days: int) -> str:
                return (today + timedelta(days=days)).isoformat()

            for name, species, age, avatar, records in [
                ("Milo", "Dog", 4, "milo", [
                    ("Rabies", -360, 5), ("DHPP", -720, 375), ("Bordetella", -160, None),
                ]),
                ("Luna", "Cat", 3, "luna", [
                    ("FVRCP", -353, 12), ("Rabies", -85, 280),
                ]),
                ("Cooper", "Dog", 2, "cooper", [
                    ("Leptospirosis", -369, -4), ("Rabies", -170, 195),
                ]),
            ]:
                pet_id = db.execute(
                    "INSERT INTO pets (name, species, born_on, avatar) VALUES (?, ?, ?, ?)",
                    (name, species, offset(-365 * age - 90), avatar),
                ).lastrowid
                db.executemany(
                    "INSERT INTO vaccinations (pet_id, vaccine, given_on, due_on) VALUES (?, ?, ?, ?)",
                    [(pet_id, vaccine, offset(given), offset(due) if due is not None else None)
                     for vaccine, given, due in records],
                )


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


def require_calendar_date(value: object) -> object:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("Enter a valid date.")
    return value


class PetIn(InputModel):
    name: Annotated[str, StringConstraints(min_length=1, max_length=60)]
    species: Annotated[str, StringConstraints(min_length=1, max_length=40)]
    born_on: date

    @field_validator("born_on", mode="before")
    @classmethod
    def parse_date(cls, value):
        return require_calendar_date(value)

    @field_validator("born_on")
    @classmethod
    def no_future_birth(cls, value: date) -> date:
        if value > date.today():
            raise ValueError("Date of birth cannot be in the future.")
        return value


class VaccinationIn(InputModel):
    vaccine: Annotated[str, StringConstraints(min_length=1, max_length=120)]
    given_on: date
    due_on: date | None = None
    clinic: Annotated[str, StringConstraints(max_length=120)] = ""
    lot: Annotated[str, StringConstraints(max_length=80)] = ""
    notes: Annotated[str, StringConstraints(max_length=500)] = ""

    @field_validator("given_on", "due_on", mode="before")
    @classmethod
    def parse_dates(cls, value, info: ValidationInfo):
        if value is None and info.field_name == "due_on":
            return None
        return require_calendar_date(value)

    @field_validator("given_on")
    @classmethod
    def no_future_administration(cls, value: date) -> date:
        if value > date.today():
            raise ValueError("Date given cannot be in the future.")
        return value

    @field_validator("due_on")
    @classmethod
    def due_after_given(cls, value: date | None, info: ValidationInfo) -> date | None:
        if value is not None and info.data.get("given_on") and value < info.data["given_on"]:
            raise ValueError("Next due date must be on or after the date given.")
        return value


class RecordBatch(InputModel):
    records: list[VaccinationIn] = Field(min_length=1, max_length=30)


def field_error(loc: list[str | int], message: str) -> HTTPException:
    return HTTPException(422, detail=[{"loc": ["body", *loc], "msg": message}])


def get_pet(db: sqlite3.Connection, pet_id: int) -> sqlite3.Row:
    pet = db.execute("SELECT * FROM pets WHERE id = ?", (pet_id,)).fetchone()
    if pet is None:
        raise HTTPException(404, "Pet profile was not found.")
    return pet


def get_record(db: sqlite3.Connection, pet_id: int, record_id: int) -> sqlite3.Row:
    row = db.execute(
        "SELECT * FROM vaccinations WHERE pet_id = ? AND id = ?", (pet_id, record_id)
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Vaccination record was not found for this pet.")
    return row


def record_values(record: VaccinationIn) -> tuple:
    return (
        record.vaccine, record.given_on.isoformat(),
        record.due_on.isoformat() if record.due_on else None,
        record.clinic, record.lot, record.notes,
    )


def create_app(
    db_path: Path | None = None,
    demo_path: Path | None = None,
    gemini_key: str | None = None,
    serve_frontend: bool = True,
) -> FastAPI:
    db_path = db_path or Path(os.getenv("PAWPASS_DB", str(HERE.parent / "data" / "pawpass.sqlite3")))
    if demo_path is None and os.getenv("PAWPASS_DEMO") == "1":
        demo_path = db_path.with_name(f"{db_path.stem}.demo.sqlite3")
    key = (gemini_key if gemini_key is not None else os.getenv("GEMINI_API_KEY", "")).strip()
    model = os.getenv("GEMINI_MODEL", "gemini-3.8-flash").strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", model):
        raise ValueError("GEMINI_MODEL must be a model ID, without the models/ prefix.")

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        initialize(db_path)
        if demo_path is not None:
            if demo_path.resolve() == db_path.resolve():
                raise RuntimeError("The demo and real workspace require different database files.")
            initialize(demo_path, demo=True)
        yield

    app = FastAPI(title="PawPass API", version="1.0.0", lifespan=lifespan)

    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])

    @app.middleware("http")
    async def api_headers(request: Request, call_next):
        if request.url.path.startswith("/api/"):
            origin = request.headers.get("origin")
            if request.method not in {"GET", "HEAD", "OPTIONS"} and origin and origin != str(request.base_url).rstrip("/"):
                return JSONResponse({"detail": "This request must come from the PawPass app."}, status_code=403)
            response = await call_next(request)
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response
        return await call_next(request)

    @app.exception_handler(RequestValidationError)
    async def validation_errors(_request: Request, exc: RequestValidationError):
        return JSONResponse(
            {"detail": [{"loc": error["loc"], "msg": error["msg"]} for error in exc.errors()]},
            status_code=422,
        )

    @app.exception_handler(sqlite3.OperationalError)
    async def database_error(_request: Request, exc: sqlite3.OperationalError):
        if getattr(exc, "sqlite_errorcode", None) in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
            return JSONResponse({"detail": "The database is busy. Please retry."}, status_code=503)
        raise exc

    def database(workspace: Annotated[Literal["personal", "demo"], Header(alias="X-PawPass-Workspace")] = "personal"):
        if workspace == "demo" and demo_path is None:
            raise HTTPException(404, "The demo workspace is unavailable.")
        with closing(connect(demo_path if workspace == "demo" else db_path)) as connection:
            yield connection

    DB = Annotated[sqlite3.Connection, Depends(database)]

    @app.get("/api/health")
    def health():
        return {"status": "ok", "demo_enabled": demo_path is not None, "extraction_enabled": bool(key)}

    @app.get("/api/dashboard")
    def dashboard(db: DB):
        db.execute("BEGIN")
        pets = [dict(pet) for pet in db.execute("SELECT * FROM pets ORDER BY id")]
        by_id = {pet["id"]: [] for pet in pets}
        for row in db.execute("SELECT * FROM vaccinations ORDER BY given_on DESC, id DESC"):
            by_id[row["pet_id"]].append(dict(row))
        return {"pets": [{**pet, "records": by_id[pet["id"]]} for pet in pets]}

    @app.post("/api/pets", status_code=201)
    def add_pet(pet: PetIn, db: DB):
        with db:
            created = db.execute(
                "INSERT INTO pets (name, species, born_on) VALUES (?, ?, ?)",
                (pet.name, pet.species, pet.born_on.isoformat()),
            )
            return {**dict(get_pet(db, created.lastrowid)), "records": []}

    @app.put("/api/pets/{pet_id}")
    def edit_pet(pet_id: int, pet: PetIn, db: DB):
        with db:
            db.execute("BEGIN IMMEDIATE")
            get_pet(db, pet_id)
            if db.execute(
                "SELECT 1 FROM vaccinations WHERE pet_id = ? AND given_on < ? LIMIT 1",
                (pet_id, pet.born_on.isoformat()),
            ).fetchone():
                raise field_error(["born_on"], "Date of birth cannot be after a saved vaccination.")
            db.execute(
                "UPDATE pets SET name = ?, species = ?, born_on = ? WHERE id = ?",
                (pet.name, pet.species, pet.born_on.isoformat(), pet_id),
            )
            return dict(get_pet(db, pet_id))

    @app.post("/api/pets/{pet_id}/vaccinations", status_code=201)
    def add_records(pet_id: int, batch: RecordBatch, db: DB):
        with db:
            db.execute("BEGIN IMMEDIATE")
            pet = get_pet(db, pet_id)
            created = []
            for index, record in enumerate(batch.records):
                if record.given_on.isoformat() < pet["born_on"]:
                    raise field_error(["records", index, "given_on"], "Date given cannot precede the pet’s birth.")
                cursor = db.execute(
                    """INSERT INTO vaccinations (pet_id, vaccine, given_on, due_on, clinic, lot, notes)
                    VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (pet_id, *record_values(record)),
                )
                created.append(dict(get_record(db, pet_id, cursor.lastrowid)))
            return {"records": created}

    @app.put("/api/pets/{pet_id}/vaccinations/{record_id}")
    def edit_record(pet_id: int, record_id: int, record: VaccinationIn, db: DB):
        with db:
            db.execute("BEGIN IMMEDIATE")
            pet = get_pet(db, pet_id)
            get_record(db, pet_id, record_id)
            if record.given_on.isoformat() < pet["born_on"]:
                raise field_error(["given_on"], "Date given cannot precede the pet’s birth.")
            db.execute(
                """UPDATE vaccinations SET vaccine = ?, given_on = ?, due_on = ?, clinic = ?, lot = ?, notes = ?
                WHERE pet_id = ? AND id = ?""",
                (*record_values(record), pet_id, record_id),
            )
            return dict(get_record(db, pet_id, record_id))

    @app.delete("/api/pets/{pet_id}/vaccinations/{record_id}", status_code=204)
    def delete_record(pet_id: int, record_id: int, db: DB):
        with db:
            deleted = db.execute("DELETE FROM vaccinations WHERE pet_id = ? AND id = ?", (pet_id, record_id))
            if not deleted.rowcount:
                raise HTTPException(404, "Vaccination record was not found for this pet.")
        return Response(status_code=204)

    @app.post("/api/extract")
    async def extract(request: Request):
        if not key:
            raise HTTPException(503, "Gemini is unavailable. You can enter the vaccination details manually.")
        media_type = request.headers.get("content-type", "").partition(";")[0].strip().lower()
        if media_type not in FORMATS:
            raise HTTPException(415, "Choose a JPEG, PNG or WebP image.")
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > MAX_UPLOAD:
                raise HTTPException(413, "Choose a photo no larger than 8 MB.")
            data.extend(chunk)
        try:
            cleaned = await run_in_threadpool(prepare_image, bytes(data), media_type)
        except InvalidImage as exc:
            raise HTTPException(422, str(exc)) from exc
        try:
            return {"records": await extract_records(cleaned, key, model)}
        except ExtractionUnavailable as exc:
            raise HTTPException(
                502, "Gemini could not read this photo right now. Try again or enter the details manually."
            ) from exc

    if serve_frontend:
        dist = HERE.parent / "frontend" / "dist"
        if (dist / "index.html").is_file():
            @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
            def frontend():
                return FileResponse(dist / "index.html", headers={"Cache-Control": "no-cache"})

            for directory in ("assets", "images"):
                if (dist / directory).is_dir():
                    app.mount(f"/{directory}", StaticFiles(directory=dist / directory))

    return app


app = create_app()
