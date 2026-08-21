#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/docker-buildx.sh [options]

Build and publish the LinkMigo Docker image for x86_64 and arm64.

Options:
  --image <name>        Docker image name. Default: DOCKER_IMAGE or k21vin/linkmigo
  --tags <tags>         Space-separated tags. Default: DOCKER_TAGS, DOCKER_TAG, or latest
  --platforms <list>    Target platforms. Default: DOCKER_PLATFORMS or linux/amd64,linux/arm64
  --builder <name>      buildx builder name. Default: DOCKER_BUILDER or linkmigo-builder
  --base-image <image>  Node base image. Default: DOCKER_BASE_IMAGE or node:22-bookworm-slim
  --install-chromium    Include Debian Chromium in the image. Enabled by default.
  --apt-mirror <url>    Optional Debian mirror root, such as http://mirrors.ustc.edu.cn
  --registry-mirror <url>
                       Optional Docker Hub registry mirror for BuildKit.
  --proxy <url>         Proxy for BuildKit, base image pulls, npm, apt, and image push.
  --no-proxy <list>     Comma-separated proxy bypass list.
  --recreate-builder    Recreate the buildx builder, useful after adding or changing proxy.
  --push               Push to registry. Default.
  --local, --load       Load a single-platform image into local Docker instead of pushing.
  -h, --help            Show this help.

Examples:
  DOCKER_IMAGE=your-dockerhub-user/linkmigo DOCKER_TAGS="0.1.0 latest" scripts/docker-buildx.sh
  scripts/docker-buildx.sh --image your-dockerhub-user/linkmigo --tags "latest" --apt-mirror http://mirrors.ustc.edu.cn
  scripts/docker-buildx.sh --image your-dockerhub-user/linkmigo --tags "latest" --registry-mirror https://your-dockerhub-mirror.example
  scripts/docker-buildx.sh --image your-dockerhub-user/linkmigo --tags "latest" --base-image your-dockerhub-mirror.example/library/node:22-bookworm-slim
  scripts/docker-buildx.sh --image your-dockerhub-user/linkmigo --tags "latest" --proxy http://host.docker.internal:7890 --recreate-builder
  scripts/docker-buildx.sh --local
EOF
}

local_platform() {
  case "$(uname -m)" in
    x86_64|amd64) echo "linux/amd64" ;;
    arm64|aarch64) echo "linux/arm64" ;;
    *) echo "linux/$(uname -m)" ;;
  esac
}

IMAGE="${DOCKER_IMAGE:-k21vin/linkmigo}"
TAGS="${DOCKER_TAGS:-${DOCKER_TAG:-latest}}"
PLATFORMS="${DOCKER_PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${DOCKER_BUILDER:-linkmigo-builder}"
BASE_IMAGE="${DOCKER_BASE_IMAGE:-node:22-bookworm-slim}"
INSTALL_CHROMIUM="${INSTALL_CHROMIUM:-1}"
APT_MIRROR="${APT_MIRROR:-}"
REGISTRY_MIRROR="${DOCKER_REGISTRY_MIRROR:-}"
PUSH="${DOCKER_PUSH:-1}"
CONTEXT="${DOCKER_CONTEXT:-.}"
DOCKERFILE_PATH="${DOCKERFILE:-Dockerfile}"
PROXY="${DOCKER_PROXY:-}"
NO_PROXY_VALUE="${DOCKER_NO_PROXY:-}"
RECREATE_BUILDER="${RECREATE_BUILDER:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image)
      IMAGE="$2"
      shift 2
      ;;
    --tags)
      TAGS="$2"
      shift 2
      ;;
    --platforms)
      PLATFORMS="$2"
      shift 2
      ;;
    --builder)
      BUILDER="$2"
      shift 2
      ;;
    --base-image)
      BASE_IMAGE="$2"
      shift 2
      ;;
    --install-chromium)
      INSTALL_CHROMIUM=1
      shift
      ;;
    --apt-mirror)
      APT_MIRROR="$2"
      shift 2
      ;;
    --registry-mirror)
      REGISTRY_MIRROR="$2"
      shift 2
      ;;
    --proxy)
      PROXY="$2"
      shift 2
      ;;
    --no-proxy)
      NO_PROXY_VALUE="$2"
      shift 2
      ;;
    --recreate-builder)
      RECREATE_BUILDER=1
      shift
      ;;
    --push)
      PUSH=1
      shift
      ;;
    --local|--load)
      PUSH=0
      if [ -z "${DOCKER_PLATFORMS:-}" ]; then
        PLATFORMS="$(local_platform)"
      fi
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$IMAGE" ]; then
  echo "Docker image name cannot be empty." >&2
  exit 1
fi

if [ -z "$TAGS" ]; then
  echo "At least one Docker tag is required." >&2
  exit 1
fi

if [ "$PUSH" != "1" ] && [ "$PUSH" != "true" ]; then
  if [[ "$PLATFORMS" == *,* ]]; then
    echo "--local/--load only supports one platform. Set DOCKER_PLATFORMS=linux/amd64 or linux/arm64." >&2
    exit 1
  fi
fi

BUILDKIT_CONFIG=""
cleanup() {
  if [ -n "$BUILDKIT_CONFIG" ] && [ -f "$BUILDKIT_CONFIG" ]; then
    rm -f "$BUILDKIT_CONFIG"
  fi
}
trap cleanup EXIT

builder_create_args=(--name "$BUILDER" --driver docker-container --use)
if [ -n "$REGISTRY_MIRROR" ]; then
  BUILDKIT_CONFIG="$(mktemp "${TMPDIR:-/tmp}/linkmigo-buildkitd.XXXXXX.toml")"
  cat > "$BUILDKIT_CONFIG" <<EOF
[registry."docker.io"]
  mirrors = ["${REGISTRY_MIRROR%/}"]
EOF
  builder_create_args+=(--config "$BUILDKIT_CONFIG")
fi

if [ -n "$PROXY" ]; then
  builder_create_args+=(
    --driver-opt "env.http_proxy=$PROXY"
    --driver-opt "env.https_proxy=$PROXY"
    --driver-opt "env.HTTP_PROXY=$PROXY"
    --driver-opt "env.HTTPS_PROXY=$PROXY"
    --driver-opt "env.ALL_PROXY=$PROXY"
    --driver-opt "env.all_proxy=$PROXY"
  )
  if [ -n "$NO_PROXY_VALUE" ]; then
    builder_create_args+=(
      --driver-opt "env.no_proxy=$NO_PROXY_VALUE"
      --driver-opt "env.NO_PROXY=$NO_PROXY_VALUE"
    )
  fi
fi

if [ "$RECREATE_BUILDER" = "1" ] || [ "$RECREATE_BUILDER" = "true" ]; then
  docker buildx rm "$BUILDER" >/dev/null 2>&1 || true
fi

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  docker buildx create "${builder_create_args[@]}" >/dev/null
else
  docker buildx use "$BUILDER" >/dev/null
fi

docker buildx inspect --bootstrap >/dev/null

build_command=(
  docker buildx build
  --file "$DOCKERFILE_PATH"
  --platform "$PLATFORMS"
)

for tag in $TAGS; do
  build_command+=(--tag "${IMAGE}:${tag}")
done

build_command+=(--build-arg "NODE_IMAGE=$BASE_IMAGE")
build_command+=(--build-arg "INSTALL_CHROMIUM=$INSTALL_CHROMIUM")

if [ -n "$APT_MIRROR" ]; then
  build_command+=(--build-arg "APT_MIRROR=$APT_MIRROR")
fi

if [ -n "$PROXY" ]; then
  build_command+=(
    --build-arg "HTTP_PROXY=$PROXY"
    --build-arg "HTTPS_PROXY=$PROXY"
    --build-arg "ALL_PROXY=$PROXY"
    --build-arg "http_proxy=$PROXY"
    --build-arg "https_proxy=$PROXY"
    --build-arg "all_proxy=$PROXY"
  )
  if [ -n "$NO_PROXY_VALUE" ]; then
    build_command+=(
      --build-arg "NO_PROXY=$NO_PROXY_VALUE"
      --build-arg "no_proxy=$NO_PROXY_VALUE"
    )
  fi
fi

output_args=(--push)
if [ "$PUSH" != "1" ] && [ "$PUSH" != "true" ]; then
  output_args=(--load)
fi

build_command+=("${output_args[@]}" "$CONTEXT")

echo "Image: ${IMAGE}"
echo "Tags: ${TAGS}"
echo "Platforms: ${PLATFORMS}"
echo "Base image: ${BASE_IMAGE}"
echo "Install Chromium: ${INSTALL_CHROMIUM}"
echo "Output: ${output_args[*]}"
if [ -n "$REGISTRY_MIRROR" ]; then
  echo "Registry mirror: ${REGISTRY_MIRROR%/}"
fi
if [ -n "$PROXY" ]; then
  echo "Proxy: ${PROXY}"
  if [ -n "$NO_PROXY_VALUE" ]; then
    echo "No proxy: ${NO_PROXY_VALUE}"
  fi
fi

"${build_command[@]}"
