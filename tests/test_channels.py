import pytest

from rovot.channels.signal_cli import SignalCliAdapter


def test_signal_secret_validation():
    adapter = SignalCliAdapter(verify_secret="secret")
    with pytest.raises(ValueError):
        adapter.parse_incoming({}, headers={"x-rovot-channel-secret": "wrong"})
