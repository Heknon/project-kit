from api.health import status


def test_reports_the_environment(monkeypatch):
    monkeypatch.setenv("APP_ENV", "preview")
    assert status() == {"ok": True, "env": "preview"}
