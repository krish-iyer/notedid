# Development commands. Everything runs in Docker (Node 26) as your own user; see README.md.
#
#   make dev      start the app at http://localhost:4322 (Ctrl-C stops it)
#   make browser  build the browser-only app and serve it at http://localhost:4323 (notes stay in the browser)
#   make browser-dist  build the browser-only app into dist/browser, to host anywhere (BASE_PATH=/folder/ for a folder)
#   make lan      serve the browser-only app on your network over HTTPS, for your phone (make lan-stop stops it)
#   make start    start the app in the background; `make logs` follows its output
#   make down     stop and remove the app container
#   make check    type-check, run the tests and build
#   make test     run the tests
#   make shell    open a shell in the container, e.g. for `npm install <package>`
#
# To use a real notes folder instead of ./dev-notes:  make dev NOTES_HOST_DIR=$HOME/notes

NOTES_HOST_DIR ?= ./dev-notes
export NOTES_HOST_DIR

COMPOSE := docker compose
RUN := $(COMPOSE) run --rm dev
DEPS := node_modules/.package-lock.json
SETUP := .env $(NOTES_HOST_DIR)

.PHONY: dev start logs check test typecheck build browser browser-dist lan lan-stop shell down image

dev: $(DEPS) | $(SETUP)
	$(COMPOSE) up dev

start: $(DEPS) | $(SETUP)
	$(COMPOSE) up -d dev
	@echo "notedid starting at http://localhost:$${WEB_PORT:-4322}  (make logs: follow output, make down: stop)"

logs: | .env
	$(COMPOSE) logs -f dev

check: $(DEPS) | $(SETUP)
	$(RUN) npm run check

test: $(DEPS) | $(SETUP)
	$(RUN) npm test

typecheck: $(DEPS) | $(SETUP)
	$(RUN) npm run typecheck

build: $(DEPS) | $(SETUP)
	$(RUN) npm run build

# The browser-only app: static files plus a service worker that stands in for the server.
BROWSER_PORT ?= 4323
browser: $(DEPS) | $(SETUP)
	$(COMPOSE) run --rm -p "127.0.0.1:$(BROWSER_PORT):$(BROWSER_PORT)" -e WEB_HOST=0.0.0.0 -e BROWSER_PORT=$(BROWSER_PORT) dev \
		sh -c "npm run build:browser && npm run preview:browser"

# The same as static files in dist/browser. Served from a folder (https://you.github.io/notedid/)? make browser-dist BASE_PATH=/notedid/
BASE_PATH ?= /
browser-dist: $(DEPS) | $(SETUP)
	$(COMPOSE) run --rm -e BASE_PATH=$(BASE_PATH) dev npm run build:browser

# On your network: the browser-only app over HTTPS (Caddy), with a certificate authority of your own that
# phones trust once (scripts/lan-certs.sh). Only the app's files are served; notes stay on each device.
LAN_PORT ?= 4443
LAN_HTTP_PORT ?= 4480
# This computer's address (the one its default route uses), and its full host name if that leads to the address.
LAN_IP ?= $(shell ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
LAN_NAME ?= $(shell n=$$(hostname -f 2>/dev/null | tr A-Z a-z); getent hosts "$$n" | grep -q "^$(LAN_IP) " && echo "$$n" | grep '\.')
lan: $(DEPS) | $(SETUP)
	@test -n "$(LAN_IP)" || { echo "Couldn't find this computer's network address: make lan LAN_IP=<address>"; exit 1; }
	$(COMPOSE) run --rm -e BROWSER_OUT=dist/lan dev sh -c 'npm run build:browser > /dev/null && sh scripts/lan-certs.sh "$(LAN_IP)" "$(LAN_NAME)" "$(LAN_PORT)"'
	-@docker rm -f notedid-lan > /dev/null 2>&1
	docker run -d --rm --name notedid-lan -p $(LAN_PORT):8443 -p $(LAN_HTTP_PORT):8080 -e LAN_IP=$(LAN_IP) \
		-v "$(CURDIR)/dist/lan:/srv:ro" -v "$(CURDIR)/.lan/public:/public:ro" -v "$(CURDIR)/.lan:/certs:ro" \
		-v "$(CURDIR)/lan/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine > /dev/null
	@echo
	@echo "notedid is on your network. On your phone, open http://$(LAN_IP):$(LAN_HTTP_PORT)/ and follow the two steps there."
	@echo "The certificate's SHA-256 fingerprint, to check on the phone: $$(cat .lan/ca.fingerprint)"
	@echo "Stop it with make lan-stop; make lan starts it again with the same certificate."

lan-stop:
	-docker rm -f notedid-lan

shell: | $(SETUP)
	$(RUN) bash

down: | .env
	$(COMPOSE) down

image: | .env
	$(COMPOSE) build dev

# Reinstall packages whenever package.json or the lockfile changes.
$(DEPS): package.json package-lock.json | $(SETUP)
	$(RUN) npm ci

# Containers run with your uid and gid, so the files they create belong to you,
# and in this machine's time zone, so logs and note history show local times.
.env:
	printf 'HOST_UID=%s\nHOST_GID=%s\nTZ=%s\n' "$$(id -u)" "$$(id -g)" \
		"$$(readlink /etc/localtime 2>/dev/null | sed -n 's|^.*/zoneinfo/||p' | grep . || echo UTC)" > .env

$(NOTES_HOST_DIR):
	mkdir -p "$@"
