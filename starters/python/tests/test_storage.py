import pytest

import storage


class FakeSts:
    def __init__(self):
        self.calls = []

    def assume_role_with_web_identity(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "Credentials": {"AccessKeyId": "AKIA", "SecretAccessKey": "secret", "SessionToken": "session"}
        }


def test_keys_carry_the_prefix(monkeypatch):
    monkeypatch.setenv("S3_PREFIX", "preview/pr-7/")
    assert storage.key("games", "1.json") == "preview/pr-7/games/1.json"
    monkeypatch.delenv("S3_PREFIX")
    assert storage.key("games", "1.json") == "games/1.json"


@pytest.mark.parametrize("part", ["", ".", "..", "a/b"])
def test_key_parts_stay_in_their_prefix(part):
    with pytest.raises(ValueError):
        storage.key(part)


def test_assumes_the_role_with_the_request_token(monkeypatch):
    monkeypatch.setenv("S3_ROLE_ARN", "arn:aws:iam::000000000000:role/test")
    monkeypatch.setenv("S3_REGION", "eu-central-1")
    monkeypatch.delenv("VERCEL_OIDC_TOKEN", raising=False)
    sts = FakeSts()
    s3 = storage.client({"x-vercel-oidc-token": "token"}, sts=sts)
    assert sts.calls[0]["WebIdentityToken"] == "token"
    assert sts.calls[0]["RoleArn"] == "arn:aws:iam::000000000000:role/test"
    assert s3.meta.region_name == "eu-central-1"


def test_a_role_without_a_token_says_what_to_do(monkeypatch):
    monkeypatch.setenv("S3_ROLE_ARN", "arn:aws:iam::000000000000:role/test")
    monkeypatch.delenv("VERCEL_OIDC_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="pass the request headers"):
        storage.client({})
