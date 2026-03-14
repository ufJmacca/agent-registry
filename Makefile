SHELL := /bin/bash
COMPOSE := docker compose

.PHONY: install up down logs lint test migrate seed compose-config

define require_docker
	@command -v docker >/dev/null 2>&1 || { echo "docker is required for '$(1)'" >&2; exit 1; }
	@docker compose version >/dev/null 2>&1 || { echo "docker compose is required for '$(1)'" >&2; exit 1; }
endef

define sync_workspace
	@tar \
		--exclude=.ai-native \
		--exclude=.git \
		--exclude=node_modules \
		--exclude='*.log' \
		-cf - . | $(COMPOSE) exec -T workspace bash -lc "find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -xf - -C /workspace"
endef

define wait_for_postgres
	@$(COMPOSE) exec -T postgres sh -lc "until pg_isready -U registry -d agent_registry >/dev/null 2>&1; do sleep 1; done"
endef

install:
	$(call require_docker,install)
	@$(COMPOSE) up -d workspace
	$(call sync_workspace)
	@$(COMPOSE) exec -T workspace bash -lc "./scripts/bootstrap.sh"

up:
	$(call require_docker,make up)
	@$(COMPOSE) up -d workspace postgres
	$(call wait_for_postgres)
	$(call sync_workspace)
	@$(COMPOSE) exec -T workspace bash -lc "./scripts/bootstrap.sh && npm run migrate"
	@$(COMPOSE) up -d api worker web

down:
	$(call require_docker,make down)
	@$(COMPOSE) down --remove-orphans

logs:
	$(call require_docker,make logs)
	@$(COMPOSE) logs -f --tail=100

lint:
	$(call require_docker,make lint)
	@$(COMPOSE) up -d workspace
	$(call sync_workspace)
	@$(COMPOSE) exec -T workspace bash -lc "./scripts/bootstrap.sh && npm run lint"

test:
	$(call require_docker,make test)
	@bash tests/workspace-foundation.test.sh --mode=outer --suite=automation
	@$(COMPOSE) up -d workspace postgres
	$(call wait_for_postgres)
	$(call sync_workspace)
	@$(COMPOSE) exec -T workspace bash -lc "./scripts/bootstrap.sh && npm run test:inner"

migrate:
	$(call require_docker,make migrate)
	@$(COMPOSE) up -d workspace postgres
	$(call wait_for_postgres)
	$(call sync_workspace)
	@$(COMPOSE) exec -T workspace bash -lc "./scripts/bootstrap.sh && npm run migrate"

seed:
	$(call require_docker,make seed)
	@$(COMPOSE) up -d workspace postgres
	$(call wait_for_postgres)
	$(call sync_workspace)
	@$(COMPOSE) exec -T workspace bash -lc "./scripts/bootstrap.sh && npm run seed"

compose-config:
	$(call require_docker,compose-config)
	@$(COMPOSE) config
