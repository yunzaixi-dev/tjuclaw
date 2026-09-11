#!/usr/bin/env python3
"""
Bootstrap NewAPI via supported HTTP API.
Accepts path to credentials.json as the ONLY argument.
Never accepts passwords via argv or prints sensitive data.
"""
import sys
import os
import json
import urllib.request
import urllib.parse
import urllib.error
import http.cookiejar

def fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)

def main():
    if len(sys.argv) != 2:
        fail("Usage: bootstrap_newapi.py <path_to_credentials.json>")

    creds_path = sys.argv[1]
    if not os.path.isfile(creds_path):
        fail(f"Credentials file {creds_path} does not exist")

    try:
        with open(creds_path, "r", encoding="utf-8") as f:
            creds = json.load(f)
    except Exception as e:
        fail(f"Failed to read credentials file: {e.__class__.__name__}")

    if not isinstance(creds, dict):
        fail("Credentials content must be a JSON object")

    username = creds.get("admin_username")
    password = creds.get("admin_password")
    if not username or not password:
        fail("Invalid credentials: admin_username and admin_password required")

    base_url = os.environ.get("NEWAPI_BASE_URL", "http://127.0.0.1:3000").rstrip("/")

    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    def make_request(method, endpoint, payload=None, extra_headers=None):
        url = f"{base_url}{endpoint}"
        headers = {"Content-Type": "application/json"}
        if extra_headers:
            headers.update(extra_headers)
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with opener.open(req, timeout=10) as resp:
                raw = resp.read().decode("utf-8")
                try:
                    parsed = json.loads(raw)
                except Exception:
                    parsed = None
                return resp.status, parsed
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8")
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = None
            return e.code, parsed
        except Exception as e:
            fail(f"Network error contacting {endpoint}: {e.__class__.__name__}")

    # 1. Check setup status (GET /api/setup)
    # root_init alone does NOT mean setup is complete (e.g. initial DB migrated or partially set).
    # Contract requires /api/setup data.status == true for complete setup.
    status_code, resp = make_request("GET", "/api/setup")
    if status_code != 200:
        fail(f"GET /api/setup returned HTTP {status_code}")

    if not isinstance(resp, dict) or resp.get("success") is not True:
        fail("GET /api/setup returned unsuccessful response")

    setup_data = resp.get("data")
    if not isinstance(setup_data, dict):
        fail("GET /api/setup data field is missing or invalid")

    is_completed = setup_data.get("status") is True

    if not is_completed:
        # Perform setup (POST /api/setup)
        setup_payload = {
            "username": username,
            "password": password,
            "confirmPassword": password,
            "SelfUseModeEnabled": True,
            "DemoSiteEnabled": False
        }
        status_code, setup_resp = make_request("POST", "/api/setup", setup_payload)
        if status_code != 200:
            fail(f"POST /api/setup returned HTTP {status_code}")

        if not isinstance(setup_resp, dict):
            fail("POST /api/setup returned invalid response format")

        if setup_resp.get("success") is not True:
            # Check if it was a race where it already completed
            msg = setup_resp.get("message") or ""
            if "已经初始化" not in msg:
                fail("POST /api/setup initialization was unsuccessful")

        # Verify /api/setup now reflects completed status
        status_code, post_check_resp = make_request("GET", "/api/setup")
        if status_code != 200 or not isinstance(post_check_resp, dict) or post_check_resp.get("success") is not True:
            fail("Failed to verify /api/setup status after initialization")
        post_data = post_check_resp.get("data")
        if not isinstance(post_data, dict) or post_data.get("status") is not True:
            fail("Setup endpoint did not report completed status after POST /api/setup")

        print("Setup completed successfully.")
    else:
        print("System already initialized.")

    # 2. Login to get session cookie and user id (POST /api/user/login)
    login_payload = {
        "username": username,
        "password": password
    }
    status_code, login_resp = make_request("POST", "/api/user/login", login_payload)
    if status_code != 200:
        fail(f"POST /api/user/login returned HTTP {status_code}")

    if not isinstance(login_resp, dict) or login_resp.get("success") is not True:
        fail("Login failed with unsuccessful response")

    login_data = login_resp.get("data")
    if not isinstance(login_data, dict):
        fail("Login response missing data object")

    user_id = None
    if "id" in login_data and login_data["id"] is not None:
        user_id = login_data["id"]
    elif "user" in login_data and isinstance(login_data["user"], dict) and "id" in login_data["user"]:
        user_id = login_data["user"]["id"]

    if type(user_id) is not int or user_id <= 0:
        fail("Login response did not contain a valid user id")

    extra_headers = {"New-Api-User": str(user_id)}
    access_token = login_data.get("access_token")
    if access_token and isinstance(access_token, str):
        extra_headers["Authorization"] = f"Bearer {access_token}"

    # 3. Read authenticated GET /api/option/
    status_code, opt_resp = make_request("GET", "/api/option/", extra_headers=extra_headers)
    if status_code != 200:
        fail(f"GET /api/option/ returned HTTP {status_code}")

    if not isinstance(opt_resp, dict) or opt_resp.get("success") is not True:
        fail("GET /api/option/ returned unsuccessful response")

    options_list = opt_resp.get("data")
    if not isinstance(options_list, list):
        fail("GET /api/option/ data is not a list")

    current_options = {}
    for opt in options_list:
        if isinstance(opt, dict) and "key" in opt:
            current_options[opt["key"]] = str(opt.get("value", ""))

    target_options = {
        "RegisterEnabled": "false",
        "PasswordRegisterEnabled": "false"
    }

    updated_any = False
    for key, target_val in target_options.items():
        curr_val = current_options.get(key)
        if curr_val != target_val:
            put_payload = {"key": key, "value": target_val}
            put_status, put_resp = make_request("PUT", "/api/option/", payload=put_payload, extra_headers=extra_headers)
            if put_status != 200:
                fail(f"PUT /api/option/ for {key} returned HTTP {put_status}")
            if not isinstance(put_resp, dict) or put_resp.get("success") is not True:
                fail(f"PUT /api/option/ for {key} failed to update")
            updated_any = True

    # Read back authenticated GET /api/option/ to confirm both values
    status_code, verify_opts_resp = make_request("GET", "/api/option/", extra_headers=extra_headers)
    if status_code != 200 or not isinstance(verify_opts_resp, dict) or verify_opts_resp.get("success") is not True:
        fail("Failed to read back options from GET /api/option/")

    verify_list = verify_opts_resp.get("data")
    if not isinstance(verify_list, list):
        fail("GET /api/option/ readback data is not a list")

    readback_opts = {}
    for opt in verify_list:
        if isinstance(opt, dict) and "key" in opt:
            readback_opts[opt["key"]] = str(opt.get("value", ""))

    for key, target_val in target_options.items():
        if readback_opts.get(key) != target_val:
            fail(f"Verification failed: option {key} did not retain the required value")

    if updated_any:
        print("Registration disabled successfully.")
    else:
        print("Registration settings already configured.")

    # 4. Anonymous GET /api/status check
    # Anonymous /api/status must advertise register_enabled=false if upstream provides it
    anon_opener = urllib.request.build_opener()
    try:
        status_req = urllib.request.Request(f"{base_url}/api/status", headers={"Content-Type": "application/json"})
        with anon_opener.open(status_req, timeout=10) as resp:
            if resp.status != 200:
                fail(f"GET /api/status returned HTTP {resp.status}")
            raw = resp.read().decode("utf-8")
            try:
                status_json = json.loads(raw)
            except Exception:
                fail("GET /api/status returned non-JSON body")
    except Exception as e:
        fail(f"Failed to check GET /api/status: {e.__class__.__name__}")

    if not isinstance(status_json, dict) or status_json.get("success") is not True:
        fail("GET /api/status response was unsuccessful")

    status_data = status_json.get("data")
    if isinstance(status_data, dict):
        if "register_enabled" in status_data and status_data["register_enabled"] is not False:
            fail("Security check failed: /api/status register_enabled is not false")
        if "password_register_enabled" in status_data and status_data["password_register_enabled"] is not False:
            fail("Security check failed: /api/status password_register_enabled is not false")

    print("NewAPI bootstrap and verification verified successfully.")

if __name__ == "__main__":
    main()
