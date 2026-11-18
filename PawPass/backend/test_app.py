import base64
import json
import tempfile
import unittest
from datetime import date, timedelta
from io import BytesIO
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient
from PIL import Image

from app import create_app
from extraction import MAX_UPLOAD, literal_date

TODAY = date.today()
GIVEN = (TODAY - timedelta(days=20)).isoformat()
BORN = (TODAY - timedelta(days=1200)).isoformat()
TOMORROW = (TODAY + timedelta(days=1)).isoformat()
PET = {"name": "Tess", "species": "Dog", "born_on": BORN}
RECORD = {"vaccine": "Example vaccine", "given_on": GIVEN, "due_on": TOMORROW, "lot": "EX123"}


def image_bytes():
    photo = BytesIO()
    Image.new("RGB", (45, 32), "#d6f1d8").save(photo, format="PNG")
    return photo.getvalue()


class PawPassTests(unittest.TestCase):
    def setUp(self):
        self.folder = self.enterContext(tempfile.TemporaryDirectory())
        self.db = Path(self.folder) / "records.sqlite3"
        self.client = self.enterContext(TestClient(
            create_app(self.db, gemini_key="", serve_frontend=False), base_url="http://localhost"
        ))

    def add_pet(self, **changes):
        result = self.client.post("/api/pets", json=PET | changes)
        self.assertEqual(result.status_code, 201, result.text)
        return result.json()["id"]

    def test_profiles_are_empty_initially_and_validate_fields(self):
        self.assertEqual(self.client.get("/api/dashboard").json(), {"pets": []})
        response = self.client.post("/api/pets", json=PET | {"name": " ", "born_on": TOMORROW})
        self.assertEqual(response.status_code, 422)
        fields = [issue["loc"][-1] for issue in response.json()["detail"]]
        self.assertEqual(set(fields), {"name", "born_on"})
        self.assertEqual(self.client.get("/api/dashboard").json(), {"pets": []})

    def test_profiles_and_records_persist_and_stay_with_their_pet(self):
        tess = self.add_pet()
        pip = self.add_pet(name="Pip", species="Cat")
        response = self.client.post(f"/api/pets/{pip}/vaccinations", json={"records": [RECORD]})
        self.assertEqual(response.status_code, 201, response.text)
        record_id = response.json()["records"][0]["id"]
        self.assertEqual(self.client.delete(f"/api/pets/{tess}/vaccinations/{record_id}").status_code, 404)
        with TestClient(create_app(self.db, gemini_key="", serve_frontend=False), base_url="http://localhost") as reopened:
            pets = reopened.get("/api/dashboard").json()["pets"]
        self.assertEqual(pets[0]["records"], [])
        self.assertEqual(pets[1]["records"][0]["pet_id"], pip)
        self.assertEqual(pets[1]["records"][0]["lot"], "EX123")

    def test_batch_with_invalid_row_rolls_back_and_reports_row(self):
        pet = self.add_pet()
        response = self.client.post(f"/api/pets/{pet}/vaccinations", json={"records": [
            RECORD, RECORD | {"given_on": "1900-01-01"},
        ]})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"][0]["loc"], ["body", "records", 1, "given_on"])
        self.assertEqual(self.client.get("/api/dashboard").json()["pets"][0]["records"], [])

    def test_record_create_edit_and_delete(self):
        pet = self.add_pet()
        path = f"/api/pets/{pet}/vaccinations"
        response = self.client.post(path, json={"records": [RECORD | {"due_on": "1900-01-01"}]})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"][0]["loc"], ["body", "records", 0, "due_on"])
        response = self.client.post(path, json={"records": [RECORD | {"due_on": None}]})
        self.assertEqual(response.status_code, 201, response.text)
        record_id = response.json()["records"][0]["id"]
        self.assertIsNone(response.json()["records"][0]["due_on"])
        update = self.client.put(f"{path}/{record_id}", json=RECORD | {"clinic": "Example clinic"})
        self.assertEqual(update.json()["clinic"], "Example clinic")
        self.assertEqual(self.client.delete(f"{path}/{record_id}").status_code, 204)
        self.assertEqual(self.client.get("/api/dashboard").json()["pets"][0]["records"], [])

    def test_cannot_move_pet_birth_after_a_record(self):
        pet = self.add_pet()
        self.client.post(f"/api/pets/{pet}/vaccinations", json={"records": [RECORD]})
        response = self.client.put(f"/api/pets/{pet}", json=PET | {"born_on": TODAY.isoformat()})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"][0]["loc"], ["body", "born_on"])
        self.assertEqual(self.client.get("/api/dashboard").json()["pets"][0]["born_on"], BORN)

    def test_demo_workspace_stays_separate(self):
        demo = Path(self.folder) / "demo.sqlite3"
        with TestClient(create_app(self.db, demo, gemini_key="", serve_frontend=False), base_url="http://localhost") as client:
            header = {"X-PawPass-Workspace": "demo"}
            self.assertEqual(len(client.get("/api/dashboard", headers=header).json()["pets"]), 3)
            self.assertEqual(client.post("/api/pets", headers=header, json=PET).status_code, 201)
            self.assertEqual(client.get("/api/dashboard").json()["pets"], [])

    def test_mutations_are_same_origin(self):
        self.assertEqual(self.client.post("/api/pets", json=PET, headers={"Origin": "https://example.test"}).status_code, 403)
        self.assertEqual(self.client.post("/api/pets", json=PET, headers={"Origin": "http://localhost"}).status_code, 201)

    def test_gemini_unavailable_allows_manual_entry(self):
        response = self.client.post("/api/extract", headers={"Content-Type": "image/png"}, content=image_bytes())
        self.assertEqual(response.status_code, 503)
        self.assertIn("manually", response.json()["detail"])
        pet = self.add_pet()
        response = self.client.post(f"/api/pets/{pet}/vaccinations", json={"records": [RECORD]})
        self.assertEqual(response.status_code, 201)

    def test_invalid_and_oversized_images_are_rejected_locally(self):
        with TestClient(create_app(self.db, gemini_key="test-key", serve_frontend=False), base_url="http://localhost") as client:
            mime = {"Content-Type": "image/png"}
            self.assertEqual(client.post("/api/extract", headers=mime, content=b"invalid").status_code, 422)
            self.assertEqual(client.post("/api/extract", headers=mime, content=b"x" * (MAX_UPLOAD + 1)).status_code, 413)
            self.assertEqual(client.post("/api/extract", content=b"invalid").status_code, 415)

    def test_extraction_returns_unsaved_drafts_and_keeps_uncertainty(self):
        text = json.dumps({"records": [
            {"vaccine": "Example", "given_on": "24 Oct 2025", "due_on": "01/02/2026", "lot": None, "clinic": None},
            {"vaccine": "Another", "given_on": None, "due_on": None, "lot": "AX99", "clinic": None},
        ]})
        result = {"candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "STOP"}]}
        with TestClient(create_app(self.db, gemini_key="test-key", serve_frontend=False), base_url="http://localhost") as client:
            self.add_pet()
            with patch("extraction.httpx.AsyncClient") as transport:
                provider = transport.return_value.__aenter__.return_value
                provider.post = AsyncMock(return_value=httpx.Response(
                    200, json=result, request=httpx.Request("POST", "https://generativelanguage.googleapis.com")
                ))
                response = client.post("/api/extract", headers={"Content-Type": "image/png"}, content=image_bytes())
                self.assertEqual(response.status_code, 200, response.text)
                request = provider.post.await_args.kwargs
                self.assertEqual(request["headers"], {"x-goog-api-key": "test-key"})
                image = request["json"]["contents"][0]["parts"][1]["inlineData"]
                self.assertEqual(image["mimeType"], "image/jpeg")
                self.assertTrue(base64.b64decode(image["data"]).startswith(b"\xff\xd8"))
            first, second = response.json()["records"]
            self.assertEqual(first["given_on"], "2025-10-24")
            self.assertIsNone(first["due_on"])
            self.assertEqual(first["due_as_written"], "01/02/2026")
            self.assertIsNone(second["given_on"])
            self.assertIsNone(second["due_on"])
            self.assertEqual(client.get("/api/dashboard").json()["pets"][0]["records"], [])

    def test_provider_failure_returns_manual_fallback(self):
        with TestClient(create_app(self.db, gemini_key="test-key", serve_frontend=False), base_url="http://localhost") as client:
            with patch("extraction.httpx.AsyncClient") as transport:
                provider = transport.return_value.__aenter__.return_value
                provider.post = AsyncMock(side_effect=httpx.ReadTimeout("upstream timeout"))
                response = client.post("/api/extract", headers={"Content-Type": "image/png"}, content=image_bytes())
        self.assertEqual(response.status_code, 502)
        self.assertIn("manually", response.json()["detail"])

    def test_normalizing_dates_never_invents_a_field(self):
        for text in [None, "Jan 2025", "1/2/2025", "31/04/2025", "9/2/25", "next year"]:
            self.assertIsNone(literal_date(text), text)
        self.assertEqual(literal_date("31/01/2025"), "2025-01-31")
        self.assertEqual(literal_date("1/31/2025"), "2025-01-31")
        self.assertEqual(literal_date("2024-02-29"), "2024-02-29")
