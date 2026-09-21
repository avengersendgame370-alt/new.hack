"""File persistence: JSON (single file) and CSV (a folder of two files).

Both back-ends implement the :class:`Storage` interface, so calling code can
swap formats without changing anything else (polymorphism again).

JSON layout
    One file containing the entire bank, written atomically.

CSV layout
    ``<folder>/accounts.csv``      one row per account
    ``<folder>/transactions.csv``  one row per transaction, keyed by account_id

The CSV format does not store the bank's display name; on load it defaults to
the folder name.
"""

from __future__ import annotations

import csv
import json
import os
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Union

from .bank import SCHEMA_VERSION, Bank
from .exceptions import (
    DuplicateAccountError,
    InvalidAccountDataError,
    StorageError,
    UnsupportedFormatError,
)

PathLike = Union[str, "os.PathLike[str]"]

ACCOUNT_FIELDS = ["account_type", "account_id", "owner", "balance", "params"]
TRANSACTION_FIELDS = [
    "account_id",
    "tx_id",
    "kind",
    "amount",
    "balance_after",
    "description",
    "timestamp",
]


class Storage(ABC):
    """Interface every persistence back-end must implement."""

    @abstractmethod
    def save(self, bank: Bank, path: PathLike) -> None:
        """Write ``bank`` to ``path``."""

    @abstractmethod
    def load(self, path: PathLike) -> Bank:
        """Read a bank from ``path``."""


class JSONStorage(Storage):
    """Persist the whole bank as one JSON document."""

    def save(self, bank: Bank, path: PathLike) -> None:
        target = Path(path)
        temp = target.with_name(target.name + ".tmp")
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with temp.open("w", encoding="utf-8") as handle:
                json.dump(bank.to_dict(), handle, indent=2, ensure_ascii=False)
            os.replace(temp, target)  # atomic: no half-written file on crash
        except OSError as exc:
            raise StorageError(f"Could not write {target}: {exc}") from exc

    def load(self, path: PathLike) -> Bank:
        source = Path(path)
        try:
            with source.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
        except FileNotFoundError:
            raise StorageError(f"File not found: {source}") from None
        except OSError as exc:
            raise StorageError(f"Could not read {source}: {exc}") from exc
        except ValueError as exc:  # JSONDecodeError and UnicodeDecodeError
            raise StorageError(f"{source} is not valid JSON: {exc}") from exc
        return Bank.from_dict(data)


class CSVStorage(Storage):
    """Persist a bank as ``accounts.csv`` + ``transactions.csv`` in a folder."""

    accounts_file = "accounts.csv"
    transactions_file = "transactions.csv"

    def save(self, bank: Bank, path: PathLike) -> None:
        folder = Path(path)
        try:
            folder.mkdir(parents=True, exist_ok=True)
            with (folder / self.accounts_file).open("w", newline="", encoding="utf-8") as fh:
                writer = csv.DictWriter(fh, fieldnames=ACCOUNT_FIELDS)
                writer.writeheader()
                for account in bank.accounts:
                    record = account.to_dict()
                    writer.writerow(
                        {
                            **{k: record[k] for k in ACCOUNT_FIELDS if k != "params"},
                            "params": json.dumps(record["params"]),
                        }
                    )
            with (folder / self.transactions_file).open("w", newline="", encoding="utf-8") as fh:
                writer = csv.DictWriter(fh, fieldnames=TRANSACTION_FIELDS)
                writer.writeheader()
                for account in bank.accounts:
                    for tx in account.transactions:
                        writer.writerow({"account_id": account.account_id, **tx.to_dict()})
        except OSError as exc:
            raise StorageError(f"Could not write CSV files in {folder}: {exc}") from exc

    def load(self, path: PathLike) -> Bank:
        folder = Path(path)
        account_rows = self._read_rows(folder / self.accounts_file, ACCOUNT_FIELDS)
        transaction_rows = self._read_rows(folder / self.transactions_file, TRANSACTION_FIELDS)

        records: dict[str, dict[str, Any]] = {}
        for row in account_rows:
            try:
                params = json.loads(row["params"] or "{}")
            except (ValueError, TypeError) as exc:
                raise InvalidAccountDataError(
                    f"Invalid 'params' for account {row['account_id']!r}: {exc}"
                ) from exc
            if row["account_id"] in records:
                raise DuplicateAccountError(row["account_id"])
            records[row["account_id"]] = {**row, "params": params, "transactions": []}

        for row in transaction_rows:
            owner = records.get(row["account_id"])
            if owner is None:
                raise InvalidAccountDataError(
                    f"Transaction {row['tx_id']!r} refers to unknown account {row['account_id']!r}"
                )
            owner["transactions"].append(row)

        return Bank.from_dict(
            {
                "version": SCHEMA_VERSION,
                "name": folder.resolve().name or "Python Bank",
                "accounts": list(records.values()),
            }
        )

    @staticmethod
    def _read_rows(file: Path, required: list[str]) -> list[dict[str, str]]:
        try:
            with file.open("r", newline="", encoding="utf-8") as handle:
                reader = csv.DictReader(handle)
                header = reader.fieldnames or []
                missing = [name for name in required if name not in header]
                if missing:
                    raise InvalidAccountDataError(
                        f"{file.name} is missing columns: {', '.join(missing)}"
                    )
                return list(reader)
        except FileNotFoundError:
            raise StorageError(f"File not found: {file}") from None
        except (OSError, UnicodeDecodeError, csv.Error) as exc:
            raise StorageError(f"Could not read {file}: {exc}") from exc


_BACKENDS: dict[str, type[Storage]] = {"json": JSONStorage, "csv": CSVStorage}


def get_storage(fmt: str) -> Storage:
    """Return a storage back-end for ``"json"`` or ``"csv"`` (case-insensitive)."""
    try:
        return _BACKENDS[str(fmt).lower()]()
    except KeyError:
        raise UnsupportedFormatError(
            f"Unsupported format {fmt!r}; choose from: {', '.join(sorted(_BACKENDS))}"
        ) from None
