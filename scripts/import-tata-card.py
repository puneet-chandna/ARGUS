"""Regenerate Tata payout rows from the pinned original workbook; leave other grids intact."""
import argparse
from decimal import Decimal
from hashlib import sha256
import json
from pathlib import Path

from openpyxl import load_workbook

root = Path(__file__).resolve().parents[1]
target = root / "lib/rating/cards.json"
cards = json.loads(target.read_text())
bundle = root / "vaatun-starter-bundle"
relative = cards["files"]["tata-aig"]
entry = next(item for item in json.loads((bundle / "MANIFEST.json").read_text())["files"] if item["path"] == relative)
original = (bundle / relative).read_bytes()
if len(original) != entry["bytes"] or sha256(original).hexdigest() != entry["sha256"]:
    raise SystemExit("Original Tata workbook differs from the pinned manifest.")

sheet = load_workbook(bundle / relative, data_only=True)["Pvtcar"]
if [cell.value.strip() for cell in sheet["G5:L5"][0]] != ["Type", "Business Type", "Fuel Type", "Section Text", "NCB", "Add On"]:
    raise SystemExit("Tata payout dimensions changed; review the original table before importing.")
cards["tata"] = {
    "clusters": [[cell.column_letter, cell.value] for cell in sheet["M5:BO5"][0]],
    "rows": [
        [row[0].row, *(cell.value for cell in row[:6]),
         [format((Decimal(str(cell.value)) * 100).normalize(), "f")
          if isinstance(cell.value, (int, float)) else None for cell in row[6:]]]
        for row in sheet.iter_rows(min_row=6, min_col=7, max_col=67)
        if str(row[3].value).strip().upper() in {"PACKAGE", "SAOD", "SATP"}
    ],
}
cards.pop("version")
canonical = json.dumps(cards, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
cards["version"] = "ts1-" + sha256(canonical.encode()).hexdigest()[:16]
serialized = json.dumps(cards, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true", help="Verify the checked-in table without writing it.")
if parser.parse_args().check:
    if target.read_text() != serialized:
        raise SystemExit("Checked-in Tata payouts differ from the original workbook.")
    print("Verified original Tata payout rows, coordinates and card version.")
else:
    target.write_text(serialized)
