import csv
import json

import pytest

from ledger import (
    Bank,
    CSVStorage,
    DuplicateAccountError,
    InvalidAccountDataError,
    JSONStorage,
    Storage,
    StorageError,
    UnsupportedFormatError,
    get_storage,
)


@pytest.fixture
def busy_bank(bank):
    bank.transfer("CHK1", "SAV1", "20", "Rent, \"June\"")  # commas/quotes stress CSV
    bank.apply_monthly_updates()
    bank.get_account("PRM1").owner = "Zoë Müller"  # non-ASCII
    return bank


# --------------------------------------------------------------------------- #
# Interface / factory
# --------------------------------------------------------------------------- #
def test_backends_implement_the_interface():
    assert isinstance(get_storage("json"), Storage)
    assert isinstance(get_storage("CSV"), CSVStorage)


def test_storage_interface_is_abstract():
    with pytest.raises(TypeError):
        Storage()


def test_unsupported_format():
    with pytest.raises(UnsupportedFormatError):
        get_storage("xml")
    with pytest.raises(StorageError):  # UnsupportedFormatError is-a StorageError
        get_storage(None)


# --------------------------------------------------------------------------- #
# JSON
# --------------------------------------------------------------------------- #
def test_json_round_trip(tmp_path, busy_bank):
    path = tmp_path / "nested" / "bank.json"
    JSONStorage().save(busy_bank, path)
    loaded = JSONStorage().load(path)
    assert loaded.to_dict() == busy_bank.to_dict()


def test_json_file_is_human_readable_and_versioned(tmp_path, busy_bank):
    path = tmp_path / "bank.json"
    JSONStorage().save(busy_bank, path)
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert raw["version"] == 1 and len(raw["accounts"]) == 3
    assert "Zoë Müller" in path.read_text(encoding="utf-8")


def test_json_save_leaves_no_temp_file_and_overwrites(tmp_path, bank):
    path = tmp_path / "bank.json"
    JSONStorage().save(bank, path)
    bank.transfer("CHK1", "SAV1", "1")
    JSONStorage().save(bank, path)
    assert [p.name for p in tmp_path.iterdir()] == ["bank.json"]
    assert JSONStorage().load(path).to_dict() == bank.to_dict()


def test_json_load_missing_file(tmp_path):
    with pytest.raises(StorageError, match="not found"):
        JSONStorage().load(tmp_path / "nope.json")


def test_json_load_invalid_syntax(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text("{ this is not json", encoding="utf-8")
    with pytest.raises(StorageError, match="not valid JSON"):
        JSONStorage().load(path)


def test_json_load_non_utf8_bytes(tmp_path):
    path = tmp_path / "bin.json"
    path.write_bytes(b"\xff\xfe\x00garbage")
    with pytest.raises(StorageError):
        JSONStorage().load(path)


def test_json_load_directory_path(tmp_path):
    with pytest.raises(StorageError):
        JSONStorage().load(tmp_path)


def test_json_load_wrong_structure(tmp_path):
    path = tmp_path / "list.json"
    path.write_text("[1, 2, 3]", encoding="utf-8")
    with pytest.raises(InvalidAccountDataError):
        JSONStorage().load(path)


def test_json_load_detects_tampering(tmp_path, bank):
    path = tmp_path / "bank.json"
    JSONStorage().save(bank, path)
    data = json.loads(path.read_text(encoding="utf-8"))
    data["accounts"][0]["balance"] = "1.00"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(InvalidAccountDataError, match="does not match"):
        JSONStorage().load(path)


def test_json_save_to_unwritable_location(tmp_path, bank):
    blocker = tmp_path / "file.txt"
    blocker.write_text("x")
    with pytest.raises(StorageError):
        JSONStorage().save(bank, blocker / "bank.json")  # parent is a file


# --------------------------------------------------------------------------- #
# CSV
# --------------------------------------------------------------------------- #
def test_csv_round_trip(tmp_path, busy_bank):
    folder = tmp_path / "export"
    CSVStorage().save(busy_bank, folder)
    loaded = CSVStorage().load(folder)
    assert [a.to_dict() for a in loaded.accounts] == [a.to_dict() for a in busy_bank.accounts]
    assert loaded.name == "export"  # CSV does not store the bank name


def test_csv_files_have_expected_shape(tmp_path, busy_bank):
    folder = tmp_path / "export"
    CSVStorage().save(busy_bank, folder)
    with (folder / "accounts.csv").open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    assert [r["account_id"] for r in rows] == ["SAV1", "CHK1", "PRM1"]
    assert json.loads(rows[0]["params"])["interest_rate"] == "0.06"
    with (folder / "transactions.csv").open(newline="", encoding="utf-8") as fh:
        tx_rows = list(csv.DictReader(fh))
    assert any("Rent" in r["description"] for r in tx_rows)


def test_csv_empty_bank_round_trip(tmp_path):
    CSVStorage().save(Bank("Empty"), tmp_path / "e")
    assert len(CSVStorage().load(tmp_path / "e")) == 0


def test_csv_missing_files(tmp_path):
    with pytest.raises(StorageError, match="not found"):
        CSVStorage().load(tmp_path / "nothing-here")


def test_csv_missing_transactions_file(tmp_path, bank):
    CSVStorage().save(bank, tmp_path)
    (tmp_path / "transactions.csv").unlink()
    with pytest.raises(StorageError):
        CSVStorage().load(tmp_path)


def test_csv_missing_columns(tmp_path, bank):
    CSVStorage().save(bank, tmp_path)
    (tmp_path / "accounts.csv").write_text("account_id,owner\nX,Y\n", encoding="utf-8")
    with pytest.raises(InvalidAccountDataError, match="missing columns"):
        CSVStorage().load(tmp_path)


def test_csv_empty_file_is_reported(tmp_path, bank):
    CSVStorage().save(bank, tmp_path)
    (tmp_path / "accounts.csv").write_text("", encoding="utf-8")
    with pytest.raises(InvalidAccountDataError):
        CSVStorage().load(tmp_path)


def test_csv_orphan_transaction(tmp_path, bank):
    CSVStorage().save(bank, tmp_path)
    with (tmp_path / "transactions.csv").open("a", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerow(["GHOST", "abc", "deposit", "1.00", "1.00", "", "2026-01-01T00:00:00"])
    with pytest.raises(InvalidAccountDataError, match="unknown account"):
        CSVStorage().load(tmp_path)


def test_csv_bad_params_cell(tmp_path, bank):
    CSVStorage().save(bank, tmp_path)
    text = (tmp_path / "accounts.csv").read_text(encoding="utf-8")
    (tmp_path / "accounts.csv").write_text(text.replace('""interest_rate""', "oops"), encoding="utf-8")
    with pytest.raises(InvalidAccountDataError, match="params"):
        CSVStorage().load(tmp_path)


def test_csv_corrupted_amount_is_rejected(tmp_path, bank):
    CSVStorage().save(bank, tmp_path)
    text = (tmp_path / "transactions.csv").read_text(encoding="utf-8")
    (tmp_path / "transactions.csv").write_text(text.replace("1000.00", "lots", 1), encoding="utf-8")
    with pytest.raises(InvalidAccountDataError):
        CSVStorage().load(tmp_path)


def test_csv_duplicate_account_rows_rejected(tmp_path, bank):
    CSVStorage().save(bank, tmp_path)
    lines = (tmp_path / "accounts.csv").read_text(encoding="utf-8").splitlines()
    (tmp_path / "accounts.csv").write_text("\n".join(lines + [lines[1]]) + "\n", encoding="utf-8")
    with pytest.raises(DuplicateAccountError):
        CSVStorage().load(tmp_path)


def test_csv_save_to_unwritable_location(tmp_path, bank):
    blocker = tmp_path / "file.txt"
    blocker.write_text("x")
    with pytest.raises(StorageError):
        CSVStorage().save(bank, blocker / "out")


def test_csv_load_undecodable_bytes(tmp_path, bank):
    CSVStorage().save(bank, tmp_path)
    (tmp_path / "accounts.csv").write_bytes(b"\xff\xfe\x00\x00bad")
    with pytest.raises(StorageError):
        CSVStorage().load(tmp_path)


# --------------------------------------------------------------------------- #
# Cross-format
# --------------------------------------------------------------------------- #
def test_json_and_csv_agree(tmp_path, busy_bank):
    JSONStorage().save(busy_bank, tmp_path / "b.json")
    CSVStorage().save(busy_bank, tmp_path / "csv")
    from_json = JSONStorage().load(tmp_path / "b.json")
    from_csv = CSVStorage().load(tmp_path / "csv")
    assert [a.to_dict() for a in from_json.accounts] == [a.to_dict() for a in from_csv.accounts]
