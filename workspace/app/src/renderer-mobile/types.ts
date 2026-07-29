// Re-exports the bits of the wire protocol the mobile bundle needs, so mobile
// components import from one place rather than reaching across into ../shared.

export {
  REMOTE_PROTOCOL_VERSION,
  type PairingOffer,
  type PromptOption,
  type RemoteInstance,
  type ServerFrame,
  type TranscriptEntry,
} from "../shared/remote-protocol";

export interface StoredPairing {
  endpoints: string[];
  hostPublicKey: string;
  deviceToken: string;
  hostName: string;
}
