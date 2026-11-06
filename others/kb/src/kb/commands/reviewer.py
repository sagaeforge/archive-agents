"""Privileged reviewer candidate installation and revocation.

Only the injected filesystem double accepts a simulated effective UID.
The real filesystem always obtains the UID from the operating system.
"""
from __future__ import annotations

import json
import os
import tempfile

from kb.write import actions, reviewer


def _root(filesystem, effective_uid):
    uid = os.geteuid() if isinstance(filesystem, reviewer.TrustFilesystem) else effective_uid
    if uid != 0:
        raise PermissionError('Reviewer installation requires root')


def _replace(filesystem, mutate):
    path = reviewer._runtime['trust_path']
    if isinstance(filesystem, reviewer.TrustFilesystem):
        # A privileged installer is intentionally root; the running KB service
        # must not be. Inspect ownership directly instead of treating installer
        # root access as an unsafe service UID.
        before = filesystem.inspect(path)
        if any(value['uid'] != 0 or value['gid'] != 0 or value['mode'] & 0o022
               or value.get('symlink') or value.get('acl_writable') for value in before.values()):
            raise PermissionError('Unsafe reviewer trust store')
        content = filesystem.read(path)
        if before != filesystem.inspect(path):
            raise PermissionError('Reviewer trust changed during installation')
        mutate(content['credentials'])
        fd, temporary = tempfile.mkstemp(prefix='.reviewers-', dir=path.parent)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                os.fchmod(stream.fileno(), 0o644)
                os.fchown(stream.fileno(), 0, 0)
                json.dump(content, stream, sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    else:
        # Test-only root filesystem double. No real permission changes.
        if filesystem is not reviewer._runtime['filesystem']:
            raise PermissionError('Unknown reviewer filesystem')
        mutate(filesystem.credentials)


def install_candidate(request_id, *, filesystem=None, effective_uid=None):
    from kb.core import conn, ledger
    filesystem = filesystem or reviewer._runtime['filesystem']
    _root(filesystem, effective_uid)
    con = conn.connect_ro(ledger.ledger_path())
    try:
        candidate = actions.load(con, 'enroll:' + request_id)
    finally:
        con.close()
    if candidate is None or candidate['rp_id'] != 'localhost' or candidate['origin'] != 'http://localhost:4812':
        raise ValueError('Invalid reviewer registration request')
    def install(credentials):
        credentials[candidate['credential_id']] = dict(public_key=candidate['public_key'], rp_id=candidate['rp_id'])
    _replace(filesystem, install)
    def consume(con):
        current = actions.load(con, 'enroll:' + request_id)
        if current is not None:
            current['consumed'] = True
            actions.save(con, 'enroll:' + request_id, current)
        return []
    actions.transaction(consume)


def revoke_credential(credential_id, *, filesystem=None, effective_uid=None):
    filesystem = filesystem or reviewer._runtime['filesystem']
    _root(filesystem, effective_uid)
    def revoke(credentials):
        credentials.pop(credential_id, None)
    _replace(filesystem, revoke)


def register(sub):
    parser = sub.add_parser('reviewer', help='특권 reviewer 키 설치·폐기')
    commands = parser.add_subparsers(dest='reviewer_command')
    enroll = commands.add_parser('enroll')
    enroll.add_argument('--request', required=True)
    enroll.set_defaults(func=lambda args: install_candidate(args.request))
    revoke = commands.add_parser('revoke')
    revoke.add_argument('--credential', required=True)
    revoke.set_defaults(func=lambda args: revoke_credential(args.credential))
    parser.set_defaults(func=lambda args: (parser.print_help(), 2)[1])
