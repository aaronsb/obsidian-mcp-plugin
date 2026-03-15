.PHONY: help build dev test lint lint-fix check clean install \
       release-patch release-minor release-major release publish sync-version

MIN_OBSIDIAN := 0.15.0

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

# --- Development ---

install: ## Install dependencies
	npm install

dev: ## Start dev mode (watch + rebuild)
	npm run dev

build: ## Build plugin (typecheck + workers + bundle)
	npm run build

# --- Quality ---

lint: ## Run ESLint
	npm run lint

lint-fix: ## Run ESLint with auto-fix
	npm run lint:fix

test: ## Run test suite
	npm test

check: build lint test ## Run all quality gates (build + lint + test)

# --- Release ---
# Full cycle: bump → sync → update versions.json → commit → push → trigger workflow

release-patch: ## Release patch (0.0.x) — check, bump, publish
	$(MAKE) check
	npm version patch --no-git-tag-version
	$(MAKE) _update-versions-json
	$(MAKE) _commit-and-publish

release-minor: ## Release minor (0.x.0) — check, bump, publish
	$(MAKE) check
	npm version minor --no-git-tag-version
	$(MAKE) _update-versions-json
	$(MAKE) _commit-and-publish

release-major: ## Release major (x.0.0) — check, bump, publish
	$(MAKE) check
	npm version major --no-git-tag-version
	$(MAKE) _update-versions-json
	$(MAKE) _commit-and-publish

publish: ## Trigger GitHub Actions release for current version
	@VERSION=$$(jq -r .version package.json); \
	echo "Publishing version $$VERSION..."; \
	gh workflow run release.yml --field release_notes="$${RELEASE_NOTES:-}"

# Internal targets (not in help)

_update-versions-json:
	@VERSION=$$(jq -r .version package.json); \
	jq --arg v "$$VERSION" --arg m "$(MIN_OBSIDIAN)" '. + {($$v): $$m}' versions.json > versions.json.tmp && \
	mv versions.json.tmp versions.json; \
	echo "Updated versions.json with $$VERSION → $(MIN_OBSIDIAN)"

_commit-and-publish:
	@VERSION=$$(jq -r .version package.json); \
	git add package.json package-lock.json manifest.json src/version.ts versions.json; \
	git commit -m "chore: Bump version to $$VERSION"; \
	git push; \
	echo "Triggering release for $$VERSION..."; \
	gh workflow run release.yml --field release_notes="$${RELEASE_NOTES:-}"

# --- Utility ---

clean: ## Remove build artifacts
	rm -rf main.js main.js.map dist/

sync-version: ## Sync version from package.json to manifest.json and version.ts
	node sync-version.mjs
