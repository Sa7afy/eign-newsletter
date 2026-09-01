#!/usr/bin/env python3
"""Authenticated, GUI-free Crunchbase GET transport.

Reads Brave's Crunchbase cookies in memory, decrypts them with the macOS
keychain, and performs a Chrome-impersonated request. Cookie values and the
Safe Storage password are never printed or persisted by this helper.
"""

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7
from curl_cffi import requests


COOKIE_DB = (
    Path.home()
    / "Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies"
)


def safe_storage_password() -> bytes:
    return subprocess.run(
        [
            "/usr/bin/security",
            "find-generic-password",
            "-w",
            "-s",
            "Brave Safe Storage",
        ],
        check=True,
        capture_output=True,
    ).stdout.rstrip(b"\n")


def decrypt_cookie(encrypted: bytes, key: bytes, host: str, db_version: int) -> str:
    if not encrypted:
        return ""
    if encrypted[:3] not in (b"v10", b"v11"):
        return encrypted.decode("utf-8")

    decryptor = Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).decryptor()
    padded = decryptor.update(encrypted[3:]) + decryptor.finalize()
    unpadder = PKCS7(128).unpadder()
    plaintext = unpadder.update(padded) + unpadder.finalize()
    if db_version >= 24 and plaintext[:32] == hashlib.sha256(host.encode()).digest():
        plaintext = plaintext[32:]
    return plaintext.decode("utf-8")


def load_crunchbase_cookies():
    password = safe_storage_password()
    key = hashlib.pbkdf2_hmac("sha1", password, b"saltysalt", 1003, dklen=16)

    source = sqlite3.connect(f"file:{COOKIE_DB}?mode=ro", uri=True)
    database = sqlite3.connect(":memory:")
    source.backup(database)
    source.close()
    version_row = database.execute(
        "SELECT value FROM meta WHERE key = 'version'"
    ).fetchone()
    db_version = int(version_row[0]) if version_row else 0
    rows = database.execute(
        """
        SELECT host_key, name, path, value, encrypted_value
        FROM cookies
        WHERE host_key = 'crunchbase.com'
           OR host_key = '.crunchbase.com'
           OR host_key = 'www.crunchbase.com'
           OR host_key = '.www.crunchbase.com'
        """
    ).fetchall()
    database.close()

    cookies = []
    for host, name, path, value, encrypted in rows:
        decrypted = value or decrypt_cookie(encrypted, key, host, db_version)
        if decrypted:
            cookies.append((host, name, path, decrypted))
    return cookies


def authenticated_session():
    session = requests.Session(impersonate="chrome")
    for domain, name, path, value in load_crunchbase_cookies():
        session.cookies.set(name, value, domain=domain, path=path or "/")
    return session


def request_endpoint(session, endpoint: str):
    response = session.get(
        "https://www.crunchbase.com" + endpoint,
        headers={
            "accept": "application/json, text/plain, */*",
            "referer": "https://www.crunchbase.com/",
        },
        timeout=90,
    )
    return {"body": response.text, "status": response.status_code}


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: crunchbase-http.py /v4/path | --worker")

    session = authenticated_session()
    if sys.argv[1] == "--worker":
        for line in sys.stdin:
            endpoint = line.rstrip("\n")
            if not endpoint.startswith("/v4/"):
                result = {"body": "Invalid Crunchbase endpoint", "status": 0}
            else:
                try:
                    result = request_endpoint(session, endpoint)
                except Exception as error:
                    result = {"body": str(error), "status": 0}
            print(json.dumps(result), flush=True)
        return

    if not sys.argv[1].startswith("/v4/"):
        raise SystemExit("usage: crunchbase-http.py /v4/path | --worker")
    print(json.dumps(request_endpoint(session, sys.argv[1])))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"body": str(error), "status": 0}))
        raise SystemExit(1)
