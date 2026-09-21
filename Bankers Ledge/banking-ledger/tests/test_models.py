from dataclasses import FrozenInstanceError
from decimal import Decimal

import pytest

from ledger.exceptions import InvalidAccountDataError
from ledger.models import Transaction, TransactionType


def make_tx(**overrides):
    base = dict(kind=TransactionType.DEPOSIT, amount=Decimal("5.00"), balance_after=Decimal("5.00"))
    base.update(overrides)
    return Transaction(**base)


def test_transaction_is_immutable():
    tx = make_tx()
    with pytest.raises(FrozenInstanceError):
        tx.amount = Decimal("999")


def test_round_trip_preserves_all_fields():
    tx = make_tx(description="Coffee, \"large\"")
    assert Transaction.from_dict(tx.to_dict()) == tx


def test_ids_are_unique():
    assert make_tx().tx_id != make_tx().tx_id


def test_negative_balance_after_is_allowed():
    tx = make_tx(kind=TransactionType.WITHDRAWAL, balance_after=Decimal("-20.00"))
    assert Transaction.from_dict(tx.to_dict()).balance_after == Decimal("-20.00")


def test_missing_fields_reported():
    data = make_tx().to_dict()
    del data["amount"]
    with pytest.raises(InvalidAccountDataError, match="amount"):
        Transaction.from_dict(data)


def test_non_mapping_rejected():
    with pytest.raises(InvalidAccountDataError):
        Transaction.from_dict("not a dict")


@pytest.mark.parametrize(
    "field, value",
    [
        ("kind", "teleport"),
        ("amount", "abc"),
        ("amount", "-1"),
        ("balance_after", "NaN"),
        ("timestamp", "yesterday"),
        ("timestamp", 12345),
    ],
)
def test_bad_field_values_raise_domain_error(field, value):
    data = make_tx().to_dict()
    data[field] = value
    with pytest.raises(InvalidAccountDataError):
        Transaction.from_dict(data)
