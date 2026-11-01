"""수집 경계(WP-06). 공개 함수: safe_fetch, capture, host_allowed, load_registry."""
from kb.collect.capturer import SnapshotRef, capture
from kb.collect.errors import Blocked, CollectError, FetchError, HostDenied, PolicyError, RegistryError
from kb.collect.fetch import Fetched, safe_fetch
from kb.collect.hostpolicy import host_allowed
from kb.collect.registry import Source, load_registry

__all__ = ["safe_fetch", "capture", "host_allowed", "load_registry", "Fetched", "SnapshotRef", "Source",
           "Blocked", "CollectError", "FetchError", "HostDenied", "PolicyError", "RegistryError"]
