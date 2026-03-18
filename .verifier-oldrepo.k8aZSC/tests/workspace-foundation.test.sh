#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="outer"
TEST_TMP_DIR=""
LAST_STDOUT_FILE=""
LAST_STDERR_FILE=""
REAL_PATH="${PATH}"
WORKSPACE_TEST_PROOF_PATH="/tmp/workspace-foundation-make-test-proof.json"
WORKSPACE_TEST_REQUEST_PATH="${ROOT_DIR}/tests/.workspace-foundation-make-test-request.txt"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

cleanup() {
  if [[ "${MODE}" == "outer" ]]; then
    (
      cd "${ROOT_DIR}"
      docker compose down --remove-orphans --volumes >/dev/null 2>&1
    ) || true
  fi

  rm -f "${WORKSPACE_TEST_REQUEST_PATH}"

  if [[ -n "${TEST_TMP_DIR}" ]]; then
    rm -rf "${TEST_TMP_DIR}"
  fi
}

trap cleanup EXIT

parse_mode() {
  case "${1:-}" in
    "" | "--mode=outer")
      MODE="outer"
      ;;
    "--mode=inner")
      MODE="inner"
      ;;
    *)
      fail "unsupported mode '${1}'"
      ;;
  esac
}

run_command_in_dir() {
  local working_dir="$1"
  local description="$2"
  shift 2

  LAST_STDOUT_FILE="$(mktemp "${TEST_TMP_DIR:-/tmp}/workspace-foundation.stdout.XXXXXX")"
  LAST_STDERR_FILE="$(mktemp "${TEST_TMP_DIR:-/tmp}/workspace-foundation.stderr.XXXXXX")"

  (
    cd "${working_dir}"
    "$@"
  ) >"${LAST_STDOUT_FILE}" 2>"${LAST_STDERR_FILE}" || {
    cat "${LAST_STDOUT_FILE}" >&2 || true
    cat "${LAST_STDERR_FILE}" >&2 || true
    fail "${description}"
  }

  echo "ok: ${description}"
}

run_command_expect_failure_in_dir() {
  local working_dir="$1"
  local description="$2"
  shift 2

  LAST_STDOUT_FILE="$(mktemp "${TEST_TMP_DIR:-/tmp}/workspace-foundation.stdout.XXXXXX")"
  LAST_STDERR_FILE="$(mktemp "${TEST_TMP_DIR:-/tmp}/workspace-foundation.stderr.XXXXXX")"

  (
    cd "${working_dir}"
    "$@"
  ) >"${LAST_STDOUT_FILE}" 2>"${LAST_STDERR_FILE}" && {
    cat "${LAST_STDOUT_FILE}" >&2 || true
    cat "${LAST_STDERR_FILE}" >&2 || true
    fail "${description}"
  }

  echo "ok: ${description}"
}

run_command_with_timeout_in_dir() {
  local working_dir="$1"
  local timeout_seconds="$2"
  local description="$3"
  shift 3

  LAST_STDOUT_FILE="$(mktemp "${TEST_TMP_DIR:-/tmp}/workspace-foundation.stdout.XXXXXX")"
  LAST_STDERR_FILE="$(mktemp "${TEST_TMP_DIR:-/tmp}/workspace-foundation.stderr.XXXXXX")"

  python3 - "${working_dir}" "${timeout_seconds}" "${LAST_STDOUT_FILE}" "${LAST_STDERR_FILE}" "$@" <<'PY' || {
import os
import signal
import subprocess
import sys

workdir = sys.argv[1]
timeout_seconds = float(sys.argv[2])
stdout_path = sys.argv[3]
stderr_path = sys.argv[4]
command = sys.argv[5:]

with open(stdout_path, "wb") as stdout, open(stderr_path, "wb") as stderr:
    process = subprocess.Popen(
        command,
        cwd=workdir,
        stdout=stdout,
        stderr=stderr,
        start_new_session=True,
    )

    try:
        process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)

        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()

        sys.exit(124)

    sys.exit(process.returncode)
PY
    cat "${LAST_STDOUT_FILE}" >&2 || true
    cat "${LAST_STDERR_FILE}" >&2 || true
    fail "${description}"
  }

  echo "ok: ${description}"
}

assert_output_contains() {
  local file_path="$1"
  local pattern="$2"

  grep -Fq "${pattern}" "${file_path}" || fail "expected output to contain '${pattern}'"
  echo "ok: output contains ${pattern}"
}

assert_last_output_contains() {
  local pattern="$1"

  if grep -Fq "${pattern}" "${LAST_STDOUT_FILE}" || grep -Fq "${pattern}" "${LAST_STDERR_FILE}"; then
    echo "ok: output contains ${pattern}"
    return
  fi

  fail "expected command output to contain '${pattern}'"
}

assert_running_services() {
  run_command_in_dir "${ROOT_DIR}" "docker compose ps should report running scaffold services" docker compose ps --format json

  node --input-type=module - "${LAST_STDOUT_FILE}" "$@" <<'NODE'
import fs from "node:fs";

const [psOutputPath, ...expectedServices] = process.argv.slice(2);
const rawOutput = fs.readFileSync(psOutputPath, "utf8").trim();
const entries = rawOutput.startsWith("[")
  ? JSON.parse(rawOutput)
  : rawOutput
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

for (const service of expectedServices) {
  const match = entries.find((entry) => {
    const entryService = entry.Service ?? entry.service ?? entry.Name ?? entry.name ?? "";
    return entryService === service || entryService.endsWith(`-${service}-1`);
  });

  if (!match) {
    console.error(`service '${service}' missing from docker compose ps output`);
    process.exit(1);
  }

  const state = String(match.State ?? match.state ?? match.Status ?? match.status ?? "").toLowerCase();
  if (!state.includes("running") && !state.includes("up")) {
    console.error(`service '${service}' is not running: ${state}`);
    process.exit(1);
  }
}
NODE

  echo "ok: expected scaffold services are running"
}

assert_compose_exec_output_contains() {
  local service_name="$1"
  local pattern="$2"
  shift 2

  run_command_in_dir "${ROOT_DIR}" "docker compose exec should succeed for ${service_name}" docker compose exec -T "${service_name}" "$@"
  assert_output_contains "${LAST_STDOUT_FILE}" "${pattern}"
}

clear_workspace_test_proof() {
  run_command_in_dir \
    "${ROOT_DIR}" \
    "docker compose exec should remove the make test proof before verification" \
    docker compose exec -T workspace rm -f "${WORKSPACE_TEST_PROOF_PATH}"
}

write_workspace_test_request() {
  local request_token="make-test-proof-$(date +%s%N)"
  printf '%s\n' "${request_token}" > "${WORKSPACE_TEST_REQUEST_PATH}"
  printf '%s\n' "${request_token}"
}

assert_workspace_test_proof() {
  local expected_request_token="$1"

  run_command_in_dir \
    "${ROOT_DIR}" \
    "docker compose exec should expose the make test proof from the workspace container" \
    docker compose exec -T workspace cat "${WORKSPACE_TEST_PROOF_PATH}"

  assert_output_contains "${LAST_STDOUT_FILE}" "\"mode\":\"inner\""
  assert_output_contains "${LAST_STDOUT_FILE}" "\"cwd\":\"/workspace\""
  assert_output_contains "${LAST_STDOUT_FILE}" "\"requestToken\":\"${expected_request_token}\""
}

write_workspace_test_proof() {
  node --input-type=module - "${WORKSPACE_TEST_PROOF_PATH}" "${WORKSPACE_TEST_REQUEST_PATH}" <<'NODE'
import fs from "node:fs";

const proofPath = process.argv[2];
const requestPath = process.argv[3];
const requestToken = fs.existsSync(requestPath)
  ? fs.readFileSync(requestPath, "utf8").trim()
  : `make-test-proof-${Date.now()}`;

if (!requestToken) {
  throw new Error("workspace test request token is required");
}

fs.writeFileSync(
  proofPath,
  JSON.stringify({
    mode: "inner",
    cwd: process.cwd(),
    requestToken,
  }),
);
NODE
}

require_real_docker() {
  command -v docker >/dev/null 2>&1 || fail "docker is required for the outer workflow suite"
  docker version >/dev/null 2>&1 || fail "docker daemon access is required for the outer workflow suite"
  docker compose version >/dev/null 2>&1 || fail "docker compose is required for the outer workflow suite"
}

setup_outer_environment() {
  require_real_docker

  TEST_TMP_DIR="$(mktemp -d)"
  mkdir -p "${TEST_TMP_DIR}/bin"

  cat <<'EOF' > "${TEST_TMP_DIR}/bin/npm"
#!/usr/bin/env bash
echo "host npm must not be used by public workflow tests" >&2
exit 99
EOF
  chmod +x "${TEST_TMP_DIR}/bin/npm"

  export PATH="${TEST_TMP_DIR}/bin:${REAL_PATH}"

  (
    cd "${ROOT_DIR}"
    docker compose down --remove-orphans --volumes >/dev/null 2>&1
  ) || true
}

test_compose_config() {
  # Arrange: real docker compose must parse the public root compose file.
  :

  # Act: validate the compose file through the real docker compose entrypoint.
  run_command_in_dir "${ROOT_DIR}" "docker compose config should validate the scaffold" docker compose config

  # Assert: the rendered config includes the expected project and services.
  assert_output_contains "${LAST_STDOUT_FILE}" "name: agent-registry"
  assert_output_contains "${LAST_STDOUT_FILE}" "postgres:"
  assert_output_contains "${LAST_STDOUT_FILE}" "api:"
}

test_make_targets_require_docker() {
  # Arrange: simulate a host without docker while keeping host npm blocked.
  local dockerless_path="${TEST_TMP_DIR}/bin"

  # Act: invoke a public workflow target with docker intentionally hidden.
  run_command_expect_failure_in_dir \
    "${ROOT_DIR}" \
    "make lint should fail fast when docker is unavailable" \
    env PATH="${dockerless_path}" /usr/bin/make lint

  # Assert: the target rejects host execution instead of silently falling back.
  assert_last_output_contains "docker is required for 'make lint'"
}

test_make_up() {
  # Arrange: start from a clean compose state.
  run_command_in_dir "${ROOT_DIR}" "docker compose down should reset scaffold state" docker compose down --remove-orphans --volumes

  # Act: start the scaffold through the public make target.
  run_command_in_dir "${ROOT_DIR}" "make up should start the scaffold services" make up

  # Assert: real compose services are running and reachable.
  assert_running_services postgres api worker web
  assert_compose_exec_output_contains postgres "accepting connections" pg_isready -U registry -d agent_registry
  assert_compose_exec_output_contains api "\"service\":\"api\"" curl -fsS http://127.0.0.1:4000
  assert_compose_exec_output_contains web "<h1>Agent Registry</h1>" curl -fsS http://127.0.0.1:3000
}

test_make_lint() {
  local injected_file="${ROOT_DIR}/apps/api/src/__workspace_foundation_lint_failure__.ts"

  cleanup_injected_file() {
    rm -f "${injected_file}"
  }

  trap cleanup_injected_file RETURN

  # Arrange: inject a real TypeScript failure so a stubbed lint target cannot pass.
  cat <<'EOF' > "${injected_file}"
const lintFailure: string = 123;
console.log(lintFailure);
EOF

  # Act: lint should fail against the broken scaffold, then succeed once the failure is removed.
  run_command_expect_failure_in_dir "${ROOT_DIR}" "make lint should fail on a real TypeScript error" make lint

  # Assert: the failure surfaced the injected file, proving the containerized lint path really ran.
  assert_last_output_contains "__workspace_foundation_lint_failure__.ts"

  rm -f "${injected_file}"
  trap - RETURN

  run_command_in_dir "${ROOT_DIR}" "make lint should succeed through the containerized workspace path" make lint
}

test_make_test() {
  local request_token=""

  # Arrange: remove any stale proof so only the current make test run can satisfy the assertion.
  clear_workspace_test_proof
  request_token="$(write_workspace_test_request)"

  # Act: run the public test target with a timeout so recursion fails fast.
  run_command_with_timeout_in_dir "${ROOT_DIR}" 180 "make test should complete through the containerized workspace path" make test

  # Assert: the inner suite completed inside the workspace container and left a container-only proof behind.
  assert_output_contains "${LAST_STDOUT_FILE}" "ok: inner compose validation should succeed"
  assert_output_contains "${LAST_STDOUT_FILE}" "ok: inner migrate placeholder should succeed"
  assert_output_contains "${LAST_STDOUT_FILE}" "ok: inner seed placeholder should succeed"
  assert_workspace_test_proof "${request_token}"
}

test_devcontainer_verify() {
  # Arrange: the devcontainer verification relies on mounted host credentials in this environment.
  :

  # Act: execute the existing verify-only command directly.
  run_command_in_dir "${ROOT_DIR}" "post-create verification should succeed" bash .devcontainer/scripts/post-create.sh --verify-only

  # Assert: the script reported the mounted credentials it requires.
  assert_output_contains "${LAST_STDOUT_FILE}" "[ok] /home/vscode/.codex/auth.json"
  assert_output_contains "${LAST_STDOUT_FILE}" "[ok] /home/vscode/.ssh"
}

run_outer_suite() {
  setup_outer_environment
  test_compose_config
  test_make_targets_require_docker
  test_make_up
  test_make_lint
  test_make_test
  test_devcontainer_verify
}

run_inner_suite() {
  # Arrange: the inner suite runs inside the workspace container path and must avoid docker recursion.
  :

  # Act: validate the compose file and the placeholder workspace scripts that make test exercises.
  run_command_in_dir "${ROOT_DIR}" "inner compose validation should succeed" node scripts/validate-compose.mjs
  run_command_in_dir "${ROOT_DIR}" "inner migrate placeholder should succeed" npm run migrate
  run_command_in_dir "${ROOT_DIR}" "inner seed placeholder should succeed" npm run seed
  write_workspace_test_proof

  # Assert: the placeholder scripts emitted the expected scaffold message.
  assert_output_contains "${LAST_STDOUT_FILE}" "Scaffold seed placeholder with 4 default environments"
}

main() {
  parse_mode "${1:-}"

  if [[ "${MODE}" == "outer" ]]; then
    run_outer_suite
  else
    run_inner_suite
  fi
}

main "$@"
