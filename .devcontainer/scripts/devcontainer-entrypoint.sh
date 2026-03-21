#!/usr/bin/env bash
set -euo pipefail

docker_socket="/var/run/docker.sock"
dev_user="vscode"

if [ -S "${docker_socket}" ]; then
  socket_gid="$(stat -c '%g' "${docker_socket}")"

  if [ "${socket_gid}" != "0" ]; then
    group_name="$(getent group "${socket_gid}" | cut -d: -f1 || true)"

    if [ -z "${group_name}" ]; then
      group_name="docker-host"
      groupadd --gid "${socket_gid}" "${group_name}"
    fi

    if ! id -nG "${dev_user}" | tr ' ' '\n' | grep -qx "${group_name}"; then
      usermod -aG "${group_name}" "${dev_user}"
    fi
  fi
fi

exec "$@"
