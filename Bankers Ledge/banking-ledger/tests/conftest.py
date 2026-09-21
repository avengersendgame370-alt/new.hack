"""Shared fixtures."""

import pytest

from ledger import Bank, CheckingAccount, PremiumCheckingAccount, SavingsAccount


@pytest.fixture
def savings():
    return SavingsAccount("SAV1", "Alice", "1000", interest_rate="0.06", min_balance="100")


@pytest.fixture
def checking():
    return CheckingAccount("CHK1", "Alice", "200", overdraft_limit="300", monthly_fee="10")


@pytest.fixture
def premium():
    return PremiumCheckingAccount("PRM1", "Bob", "1000")


@pytest.fixture
def bank(savings, checking, premium):
    b = Bank("Test Bank")
    for account in (savings, checking, premium):
        b.add_account(account)
    return b
