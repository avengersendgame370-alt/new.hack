"""Immutable value objects that make up the ledger's audit trail."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from typing import Any, Mapping

from .exceptions import InvalidAccountDataError
from .money import to_money


class TransactionType(str, Enum):
    """The kinds of entries that can appear in an account's history."""

    DEPOSIT = "deposit"
    WITHDRAWAL = "withdrawal"
    TRANSFER_IN = "transfer_in"
    TRANSFER_OUT = "transfer_out"
    INTEREST = "interest"
    FEE = "fee"


_REQUIRED_FIELDS = ("tx_id", "kind", "amount", "balance_after", "timestamp")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


@dataclass(frozen=True)
class Transaction:
    """A single, immutable ledger entry.

    ``amount`` is always positive; the direction of money flow is implied by
    ``kind``. ``balance_after`` records the account balance once the entry was
    applied, which allows the history to be audited for consistency.
    """

    kind: TransactionType
    amount: Decimal
    balance_after: Decimal
    description: str = ""
    timestamp: datetime = field(default_factory=_utc_now)
    tx_id: str = field(default_factory=_new_id)

    def to_dict(self) -> dict[str, str]:
        """Serialise to plain strings so JSON and CSV can share one format."""
        return {
            "tx_id": self.tx_id,
            "kind": self.kind.value,
            "amount": str(self.amount),
            "balance_after": str(self.balance_after),
            "description": self.description,
            "timestamp": self.timestamp.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Transaction":
        """Rebuild a transaction, raising :class:`InvalidAccountDataError` on bad input."""
        if not isinstance(data, Mapping):
            raise InvalidAccountDataError("Transaction record must be an object")
        missing = [key for key in _REQUIRED_FIELDS if key not in data]
        if missing:
            raise InvalidAccountDataError(
                f"Transaction record is missing fields: {', '.join(missing)}"
            )
        try:
            return cls(
                kind=TransactionType(data["kind"]),
                amount=to_money(data["amount"], "amount"),
                balance_after=to_money(
                    data["balance_after"],
                    "balance_after",
                    allow_zero=True,
                    allow_negative=True,
                ),
                description=str(data.get("description") or ""),
                timestamp=datetime.fromisoformat(data["timestamp"]),
                tx_id=str(data["tx_id"]),
            )
        except (ValueError, TypeError) as exc:
            raise InvalidAccountDataError(f"Invalid transaction record: {exc}") from exc
