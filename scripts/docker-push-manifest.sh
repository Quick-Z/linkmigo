#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/docker-push-manifest.sh [options]

Push locally built platform images, then publish multi-arch manifest tags.

Expected local tags:
  <image>:<tag>-amd64
  <image>:<tag>-arm64

Options:
  --image <name>        Docker image name. Default: DOCKER_IMAGE or k21vin/linkmigo
  --tags <tags>         Space-separated manifest tags. Default: DOCKER_TAGS, DOCKER_TAG, or latest
  --platforms <list>    Source platforms. Default: linux/amd64,linux/arm64
  -h, --help            Show this help.

Example:
  scripts/docker-push-manifest.sh --image k21vin/linkmigo --tags "0.1.0 latest"
EOF
}

suffix_for_platform() {
  case "$1" in
    linux/amd64) echo "amd64" ;;
    linux/arm64) echo "arm64" ;;
    *)
      echo "Unsupported platform for manifest push: $1" >&2
      exit 1
      ;;
  esac
}

IMAGE="${DOCKER_IMAGE:-k21vin/linkmigo}"
TAGS="${DOCKER_TAGS:-${DOCKER_TAG:-latest}}"
PLATFORMS="${DOCKER_PLATFORMS:-linux/amd64,linux/arm64}"

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

platform_list="${PLATFORMS//,/ }"

for tag in $TAGS; do
  source_images=()

  for platform in $platform_list; do
    suffix="$(suffix_for_platform "$platform")"
    source_image="${IMAGE}:${tag}-${suffix}"
    source_images+=("$source_image")

    echo "Pushing ${source_image}"
    docker push "$source_image"
  done

  echo "Publishing multi-arch manifest ${IMAGE}:${tag}"
  docker buildx imagetools create \
    --tag "${IMAGE}:${tag}" \
    "${source_images[@]}"
done
