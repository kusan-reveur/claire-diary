"""Print, as JSON, what each OpenTimestamps proof attests (read-only).

For every .ots file: the SHA-256 digest it timestamps, each Bitcoin block-header
attestation with the merkle root that block must contain (explorer byte order),
and the calendars still pending. scripts/anchor.mjs checks those merkle roots
against two independent Bitcoin explorers.
"""
import json
import sys

from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
from opentimestamps.core.op import OpSHA256
from opentimestamps.core.serialize import StreamDeserializationContext
from opentimestamps.core.timestamp import DetachedTimestampFile


def describe(path):
    with open(path, "rb") as fd:
        proof = DetachedTimestampFile.deserialize(StreamDeserializationContext(fd))
    if not isinstance(proof.file_hash_op, OpSHA256):
        raise ValueError("unsupported_proof_hash")
    bitcoin, pending = [], []
    for message, attestation in proof.timestamp.all_attestations():
        if isinstance(attestation, BitcoinBlockHeaderAttestation):
            if len(message) != 32:
                raise ValueError("invalid_bitcoin_attestation")
            bitcoin.append({"height": attestation.height, "merkleRoot": message[::-1].hex()})
        elif isinstance(attestation, PendingAttestation):
            pending.append(attestation.uri)
    return {"path": path, "digest": proof.file_digest.hex(), "bitcoin": bitcoin, "pending": pending}


if __name__ == "__main__":
    try:
        print(json.dumps([describe(path) for path in sys.argv[1:]]))
    except Exception:
        print("invalid_proof_file", file=sys.stderr)
        sys.exit(1)
