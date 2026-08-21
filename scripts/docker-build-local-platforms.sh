#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/docker-build-local-platforms.sh [options]

Build amd64 and arm64 images locally without pushing. Each platform is built
with docker build and tagged with a platform suffix, for example:
  k21vin/linkmigo:0.1.0-amd64
  k21vin/linkmigo:0.1.0-arm64

Local split builds do not create or select a buildx builder. This keeps them on
the current Docker Desktop context and avoids docker-container builder proxy
configuration issues.

Options:
  --image <name>        Docker image name. Default: DOCKER_IMAGE or k21vin/linkmigo
  --tags <tags>         Space-separated tags. Default: DOCKER_TAGS, DOCKER_TAG, or latest
  --platforms <list>    Target platforms. Default: linux/amd64,linux/arm64
  --base-image <image>  Node base image. Default: DOCKER_BASE_IMAGE or node:22-bookworm-slim
  --install-chromium    Include Debian Chromium in the image. Enabled by default.
  --apt-mirror <url>    Optional Debian mirror root, such as http://mirrors.ustc.edu.cn
  --proxy <url>         Proxy build args for npm and apt inside Dockerfile RUN steps.
  --no-proxy <list>     Comma-separated proxy bypass list.
  --file <path>         Dockerfile path. Default: DOCKERFILE or Dockerfile
  --context <path>      Build context. Default: DOCKER_CONTEXT or .
  -h, --help            Show this help.

Example:
  scripts/docker-build-local-platforms.sh --image k21vin/linkmigo --tags "0.1.0 latest"
EOF
}

suffix_for_platform() {
  case "$1" in
    linux/amd64) echo "amd64" ;;
    linux/arm64) echo "arm64" ;;
    *)
      echo "Unsupported platform for local split build: $1" >&2
      exit 1
      ;;
  esac
}

IMAGE="${DOCKER_IMAGE:-k21vin/linkmigo}"
TAGS="${DOCKER_TAGS:-${DOCKER_TAG:-latest}}"
PLATFORMS="${DOCKER_PLATFORMS:-linux/amd64,linux/arm64}"
BASE_IMAGE="${DOCKER_BASE_IMAGE:-node:22-bookworm-slim}"
INSTALL_CHROMIUM="${INSTALL_CHROMIUM:-1}"
APT_MIRROR="${APT_MIRROR:-}"
PROXY="${DOCKER_PROXY:-}"
NO_PROXY_VALUE="${DOCKER_NO_PROXY:-}"
DOCKERFILE_PATH="${DOCKERFILE:-Dockerfile}"
CONTEXT="${DOCKER_CONTEXT:-.}"

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
    --proxy)
      PROXY="$2"
      shift 2
      ;;
    --no-proxy)
      NO_PROXY_VALUE="$2"
      shift 2
      ;;
    --file)
      DOCKERFILE_PATH="$2"
      shift 2
      ;;
    --context)
      CONTEXT="$2"
      shift 2
      ;;
    --builder|--registry-mirror)
      echo "Ignoring buildx-only option for local docker build: $1 $2" >&2
      shift 2
      ;;
    --recreate-builder)
      echo "Ignoring buildx-only option for local docker build: $1" >&2
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --local|--load)
      shift
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

platform_list="${PLATFORMS//,/ }"

for platform in $platform_list; do
  suffix="$(suffix_for_platform "$platform")"
  tag_args=()
  for tag in $TAGS; do
    tag_args+=(--tag "${IMAGE}:${tag}-${suffix}")
  done

  echo
  echo "Building ${platform}"
  build_command=(
    docker build
    --file "$DOCKERFILE_PATH"
    --platform "$platform"
    --build-arg "NODE_IMAGE=$BASE_IMAGE"
    --build-arg "INSTALL_CHROMIUM=$INSTALL_CHROMIUM"
  )
  build_command+=("${tag_args[@]}")
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
  build_command+=("$CONTEXT")

  echo "Base image: ${BASE_IMAGE}"
  echo "Install Chromium: ${INSTALL_CHROMIUM}"
  for tag_arg in "${tag_args[@]}"; do
    if [ "$tag_arg" != "--tag" ]; then
      echo "Tag: ${tag_arg}"
    fi
  done
  "${build_command[@]}"
done

echo
echo "Local platform images are ready:"
for platform in $platform_list; do
  suffix="$(suffix_for_platform "$platform")"
  for tag in $TAGS; do
    echo "  ${IMAGE}:${tag}-${suffix}"
  done
done
