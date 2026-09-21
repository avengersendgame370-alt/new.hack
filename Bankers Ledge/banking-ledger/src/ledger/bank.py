"""The ledger engine: owns accounts and coordinates operations between them."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping, Optional

from .accounts import Account
from .exceptions import (
    AccountNotFoundError,
    DuplicateAccountError,
    InvalidAccountDataError,
    InvalidTransferError,
)
from .models import Transaction
from .money import ZERO, to_money

SCHEMA_VERSION = 1


class Bank:
    """A collection of accounts with transfer and month-end processing."""

    def __init__(self, name: str = "Python Bank") -> None:
        if not isinstance(name, str) or not name.strip():
            raise InvalidAccountDataError("Bank name must be a non-empty string")
        self._name = name.strip()
        self._accounts: dict[str, Account] = {}

    # ------------------------------------------------------------------ #
    @property
    def name(self) -> str:
        return self._name

    @property
    def accounts(self) -> tuple[Account, ...]:
        return tuple(self._accounts.values())

    def __len__(self) -> int:
        return len(self._accounts)

    def __contains__(self, account_id: object) -> bool:
        return account_id in self._accounts

    # ------------------------------------------------------------------ #
    def add_account(self, account: Account) -> Account:
        if not isinstance(account, Account):
            raise InvalidAccountDataError("Only Account instances can be added")
        if account.account_id in self._accounts:
            raise DuplicateAccountError(account.account_id)
        self._accounts[account.account_id] = account
        return account

    def create_account(
        self, account_type: str, account_id: str, owner: str, **options: Any
    ) -> Account:
        """Factory: build an account of the named type and register it."""
        klass = Account.for_type(account_type)
        if account_id in self._accounts:
            raise DuplicateAccountError(account_id)
        return self.add_account(klass(account_id, owner, **options))

    def get_account(self, account_id: str) -> Account:
        try:
            return self._accounts[account_id]
        except (KeyError, TypeError):
            raise AccountNotFoundError(str(account_id)) from None

    # ------------------------------------------------------------------ #
    def transfer(
        self,
        source_id: str,
        target_id: str,
        amount: Any,
        description: str = "Transfer",
    ) -> tuple[Transaction, Transaction]:
        """Move money between two accounts.

        Every check (accounts exist, amount valid, funds sufficient) happens
        before any balance changes, so a failed transfer leaves both accounts
        untouched.
        """
        if source_id == target_id:
            raise InvalidTransferError("Cannot transfer to the same account")
        source = self.get_account(source_id)
        target = self.get_account(target_id)
        value = to_money(amount)

        debit = source.transfer_out(value, f"{description} to {target_id}")
        credit = target.transfer_in(value, f"{description} from {source_id}")
        return debit, credit

    def apply_monthly_updates(self) -> dict[str, Optional[Transaction]]:
        """Polymorphically run each account's own month-end rule."""
        return {
            account_id: account.apply_monthly_update()
            for account_id, account in self._accounts.items()
        }

    def total_holdings(self) -> Decimal:
        return sum((a.balance for a in self._accounts.values()), ZERO)

    # ------------------------------------------------------------------ #
    def to_dict(self) -> dict[str, Any]:
        return {
            "version": SCHEMA_VERSION,
            "name": self._name,
            "accounts": [account.to_dict() for account in self._accounts.values()],
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Bank":
        if not isinstance(data, Mapping):
            raise InvalidAccountDataError("Bank data must be an object")
        version = data.get("version", SCHEMA_VERSION)
        if version != SCHEMA_VERSION:
            raise InvalidAccountDataError(
                f"Unsupported data version {version!r} (expected {SCHEMA_VERSION})"
            )
        records = data.get("accounts")
        if not isinstance(records, list):
            raise InvalidAccountDataError("'accounts' must be a list")

        bank = cls(data.get("name", "Python Bank"))
        for record in records:
            bank.add_account(Account.from_dict(record))
        return bank

    def __repr__(self) -> str:
        return f"Bank(name={self._name!r}, accounts={len(self)})"
