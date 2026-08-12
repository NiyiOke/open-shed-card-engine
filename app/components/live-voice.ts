"use client";

import type {
  LocalTrackPublication,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
} from "livekit-client";

export type LiveVoiceStatus =
  | "unavailable"
  | "available"
  | "prejoin"
  | "requesting_permission"
  | "joining"
  | "joined_muted"
  | "joined_live"
  | "reconnecting"
  | "listen_only"
  | "permission_denied"
  | "failed"
  | "ended";

export type LiveVoiceParticipant = Readonly<{
  playerId: string;
  displayName: string;
  connected: boolean;
  microphoneEnabled: boolean;
  speaking: boolean;
  self: boolean;
}>;

export type LiveVoiceSnapshot = Readonly<{
  status: LiveVoiceStatus;
  microphoneEnabled: boolean;
  outputMuted: boolean;
  audioPlaybackBlocked: boolean;
  participants: ReadonlyArray<LiveVoiceParticipant>;
  error: string | null;
}>;

type SessionParticipant = Readonly<{
  identity: string;
  playerId: string;
  displayName: string;
}>;

type VoiceSessionResponse = Readonly<{
  provider: "livekit";
  serverUrl: string;
  token: string;
  expiresAt: number;
  participantIdentity: string;
  participants: ReadonlyArray<SessionParticipant>;
}>;

export type LiveVoiceController = Readonly<{
  getSnapshot(): LiveVoiceSnapshot;
  markAvailable(): void;
  openPrejoin(): void;
  join(): Promise<void>;
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  setOutputMuted(muted: boolean): void;
  resumeAudio(): Promise<boolean>;
  leave(): Promise<void>;
  dispose(): Promise<void>;
}>;

export type LiveVoiceControllerOptions = Readonly<{
  gameId: string;
  onChange?: (snapshot: LiveVoiceSnapshot) => void;
  fetcher?: typeof fetch;
  createRoom?: () => Room;
  loadLiveKit?: () => Promise<typeof import("livekit-client")>;
  documentRef?: Document | null;
  scheduleRosterRefresh?: (callback: () => void, delayMs: number) => () => void;
}>;

const INITIAL_SNAPSHOT: LiveVoiceSnapshot = Object.freeze({
  status: "unavailable",
  microphoneEnabled: false,
  outputMuted: false,
  audioPlaybackBlocked: false,
  participants: Object.freeze([]),
  error: null,
});

/**
 * Provider-neutral UI controller. No microphone is requested by `join()`;
 * players enter listen-only/muted and must explicitly unmute before the SDK
 * requests device permission. Media never traverses the game API or D1.
 */
export function createLiveVoiceController(
  options: LiveVoiceControllerOptions,
): LiveVoiceController {
  const fetcher = options.fetcher ?? fetch;
  const loadLiveKit = options.loadLiveKit ?? (() => import("livekit-client"));
  const documentRef = options.documentRef ??
    (typeof document === "undefined" ? null : document);
  const scheduleRosterRefresh = options.scheduleRosterRefresh ??
    (documentRef
      ? (callback: () => void, delayMs: number) => {
          const handle = window.setTimeout(callback, delayMs);
          return () => window.clearTimeout(handle);
        }
      : null);
  let room: Room | null = null;
  let liveKit: typeof import("livekit-client") | null = null;
  let session: VoiceSessionResponse | null = null;
  let disposed = false;
  let lifecycleEpoch = 0;
  let snapshot = INITIAL_SNAPSHOT;
  let joining: Promise<void> | null = null;
  let rosterRefresh: Promise<void> | null = null;
  let rosterRefreshQueued = false;
  let cancelRosterRefresh: (() => void) | null = null;
  const audioElements = new Set<HTMLMediaElement>();
  const activeSpeakerIds = new Set<string>();
  const sessionRequests = new Set<AbortController>();
  const attachedRemoteTracks = new Map<RemoteTrack, string>();

  const publish = (patch: Partial<LiveVoiceSnapshot>) => {
    if (disposed) return;
    snapshot = Object.freeze({
      ...snapshot,
      ...patch,
      participants: patch.participants
        ? Object.freeze([...patch.participants])
        : snapshot.participants,
    });
    options.onChange?.(snapshot);
  };

  const controller: LiveVoiceController = {
    getSnapshot: () => snapshot,
    markAvailable: () => {
      if (snapshot.status === "unavailable" || snapshot.status === "ended") {
        publish({ status: "available", error: null });
      }
    },
    openPrejoin: () => {
      if (snapshot.status === "available") publish({ status: "prejoin", error: null });
    },
    join: async () => {
      if (disposed || room) return;
      if (joining) return joining;
      const epoch = lifecycleEpoch;
      const nextJoining = connect(epoch);
      joining = nextJoining;
      try {
        await nextJoining;
      } finally {
        if (joining === nextJoining) joining = null;
      }
    },
    setMicrophoneEnabled: async (enabled) => setMicrophoneEnabled(enabled),
    setOutputMuted: (muted) => {
      for (const element of audioElements) element.muted = muted;
      publish({ outputMuted: muted });
    },
    resumeAudio: async () => {
      const activeRoom = room;
      const epoch = lifecycleEpoch;
      if (!activeRoom || !isCurrent(epoch)) return false;
      try {
        await activeRoom.startAudio();
        if (!isCurrent(epoch) || room !== activeRoom) return false;
        publish({ audioPlaybackBlocked: false, error: null });
        return true;
      } catch {
        if (!isCurrent(epoch) || room !== activeRoom) return false;
        publish({
          audioPlaybackBlocked: true,
          error: "Your browser is waiting for permission to play table audio.",
        });
        return false;
      }
    },
    leave: async () => {
      const epoch = invalidateLifecycle();
      await disconnectActiveRoom("ended", epoch);
    },
    dispose: async () => {
      if (disposed && !room) return;
      disposed = true;
      lifecycleEpoch += 1;
      cancelRosterRefresh?.();
      cancelRosterRefresh = null;
      abortSessionRequests();
      await disconnectActiveRoom("ended", lifecycleEpoch);
    },
  };

  async function connect(epoch: number): Promise<void> {
    if (!isCurrent(epoch)) return;
    publish({ status: "joining", error: null });
    let nextRoom: Room | null = null;
    try {
      const response = await requestVoiceSession(epoch);
      if (!response || !isCurrent(epoch)) return;
      if (!response.ok) {
        const code = await readErrorCode(response);
        if (!isCurrent(epoch)) return;
        publish({
          status: code === "LIVE_VOICE_UNAVAILABLE" ? "unavailable" : "failed",
          error:
            code === "LIVE_VOICE_PRIVATE_ONLY"
              ? "Live voice is available only in private invite tables."
              : code === "LIVE_VOICE_BLOCKED"
                ? "Live voice is unavailable while a block is active at this table."
                : code === "LIVE_VOICE_UNAVAILABLE"
                  ? "Voice setup is not available on this deployment yet."
                  : "Live voice could not connect.",
        });
        return;
      }
      const responseValue = await response.json();
      if (!isCurrent(epoch)) return;
      const payload = parseVoiceSession(responseValue);
      if (!payload) {
        publish({ status: "failed", error: "The voice service returned an invalid session." });
        return;
      }
      const sdk = await loadLiveKit();
      if (!isCurrent(epoch)) return;
      liveKit = sdk;
      session = payload;
      nextRoom = options.createRoom?.() ?? new sdk.Room({
        adaptiveStream: true,
        dynacast: true,
      });
      if (!isCurrent(epoch)) {
        await disconnectLateRoom(nextRoom, sdk);
        return;
      }
      bindRoom(nextRoom, epoch);
      room = nextRoom;
      await nextRoom.connect(payload.serverUrl, payload.token, {
        autoSubscribe: false,
      });
      if (!isCurrent(epoch) || room !== nextRoom) {
        await disconnectLateRoom(nextRoom, sdk);
        return;
      }
      if (nextRoom.localParticipant.identity !== payload.participantIdentity) {
        const failureEpoch = invalidateLifecycle();
        await disconnectActiveRoom("failed", failureEpoch, nextRoom);
        if (isCurrent(failureEpoch)) {
          publish({ status: "failed", error: "The voice identity could not be verified." });
        }
        return;
      }
      syncAuthorizedSubscriptions();
      armRosterRefresh(epoch);
      publish({
        status: "joined_muted",
        microphoneEnabled: false,
        error: null,
        participants: participantSnapshot(),
      });
      await controller.resumeAudio();
      if (!isCurrent(epoch) || room !== nextRoom) {
        await disconnectLateRoom(nextRoom, sdk);
      }
    } catch {
      if (!isCurrent(epoch)) {
        if (nextRoom) await disconnectLateRoom(nextRoom, liveKit);
        return;
      }
      const failureEpoch = invalidateLifecycle();
      await disconnectActiveRoom("failed", failureEpoch);
      if (!isCurrent(failureEpoch)) return;
      publish({ status: "failed", error: "Live voice could not connect." });
    }
  }

  function bindRoom(nextRoom: Room, epoch: number): void {
    if (!liveKit) return;
    const { RoomEvent } = liveKit;
    nextRoom
      .on(RoomEvent.ParticipantConnected, (participant) => {
        if (!isCurrent(epoch) || room !== nextRoom) return;
        syncParticipantSubscriptions(participant);
        updateParticipants();
        if (!isAuthorizedIdentity(participant.identity)) void refreshRoster(epoch);
      })
      .on(RoomEvent.ParticipantDisconnected, () => {
        if (isCurrent(epoch) && room === nextRoom) updateParticipants();
      })
      .on(RoomEvent.TrackMuted, () => {
        if (isCurrent(epoch) && room === nextRoom) updateParticipants();
      })
      .on(RoomEvent.TrackUnmuted, () => {
        if (isCurrent(epoch) && room === nextRoom) updateParticipants();
      })
      .on(RoomEvent.TrackPublished, (publication, participant) => {
        if (!isCurrent(epoch) || room !== nextRoom) return;
        syncPublicationSubscription(publication, participant);
        if (!isAuthorizedIdentity(participant.identity)) void refreshRoster(epoch);
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        if (!isCurrent(epoch) || room !== nextRoom) return;
        activeSpeakerIds.clear();
        for (const speaker of speakers) activeSpeakerIds.add(speaker.identity);
        updateParticipants();
      })
      .on(RoomEvent.Reconnecting, () => {
        if (isCurrent(epoch) && room === nextRoom) publish({ status: "reconnecting" });
      })
      .on(RoomEvent.Reconnected, () => {
        if (!isCurrent(epoch) || room !== nextRoom) return;
        publish({
          status: snapshot.microphoneEnabled ? "joined_live" : "joined_muted",
          error: null,
          participants: participantSnapshot(),
        });
      })
      .on(RoomEvent.Disconnected, () => {
        if (isCurrent(epoch) && room === nextRoom) {
          cancelRosterRefresh?.();
          cancelRosterRefresh = null;
          cleanupDetachedMedia();
          activeSpeakerIds.clear();
          room = null;
          session = null;
          liveKit = null;
          publish({
            status: "ended",
            microphoneEnabled: false,
            participants: [],
          });
        }
      })
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (!isCurrent(epoch) || room !== nextRoom) return;
        if (isAuthorizedIdentity(participant.identity)) {
          attachRemoteAudio(track, participant.identity);
        } else {
          publication.setSubscribed(false);
          detachRemoteAudio(track);
          void refreshRoster(epoch);
        }
        updateParticipants();
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        if (!isCurrent(epoch) || room !== nextRoom) return;
        detachRemoteAudio(track);
        updateParticipants();
      });
  }

  function attachRemoteAudio(track: RemoteTrack, identity: string): void {
    if (
      disposed ||
      attachedRemoteTracks.has(track) ||
      !liveKit ||
      track.kind !== liveKit.Track.Kind.Audio ||
      !isAuthorizedIdentity(identity) ||
      !documentRef
    ) {
      return;
    }
    const element = track.attach();
    element.autoplay = true;
    element.muted = snapshot.outputMuted;
    element.dataset.openShedVoice = "remote-audio";
    element.hidden = true;
    audioElements.add(element);
    attachedRemoteTracks.set(track, identity);
    documentRef.body.appendChild(element);
  }

  function detachRemoteAudio(track: RemoteTrack): void {
    attachedRemoteTracks.delete(track);
    for (const element of track.detach()) {
      audioElements.delete(element);
      element.remove();
    }
  }

  function updateParticipants(): void {
    publish({ participants: participantSnapshot() });
  }

  function isAuthorizedIdentity(identity: string): boolean {
    return Boolean(
      session?.participants.some((participant) => participant.identity === identity),
    );
  }

  function syncAuthorizedSubscriptions(): void {
    if (!room || !liveKit) return;
    for (const participant of room.remoteParticipants.values()) {
      syncParticipantSubscriptions(participant);
    }
    for (const [track, identity] of attachedRemoteTracks) {
      if (!isAuthorizedIdentity(identity)) detachRemoteAudio(track);
    }
  }

  function syncParticipantSubscriptions(participant: RemoteParticipant): void {
    for (const publication of participant.audioTrackPublications.values()) {
      syncPublicationSubscription(publication, participant);
    }
  }

  function syncPublicationSubscription(
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    if (!liveKit || publication.source !== liveKit.Track.Source.Microphone) return;
    const authorized = isAuthorizedIdentity(participant.identity);
    publication.setSubscribed(authorized);
    if (!authorized && publication.track) detachRemoteAudio(publication.track);
  }

  function participantSnapshot(): LiveVoiceParticipant[] {
    if (!room || !session || !liveKit) return [];
    const sdk = liveKit;
    const connectedIdentities = new Set<string>([
      room.localParticipant.identity,
      ...room.remoteParticipants.keys(),
    ]);
    return session.participants
      .filter((participant) => connectedIdentities.has(participant.identity))
      .map((participant) => {
        const sdkParticipant = participant.identity === room?.localParticipant.identity
          ? room.localParticipant
          : room?.remoteParticipants.get(participant.identity);
        const microphone = sdkParticipant?.getTrackPublication(
          sdk.Track.Source.Microphone,
        );
        return Object.freeze({
          playerId: participant.playerId,
          displayName: participant.displayName,
          connected: Boolean(sdkParticipant),
          microphoneEnabled: Boolean(microphone && !microphone.isMuted),
          speaking: activeSpeakerIds.has(participant.identity),
          self: participant.identity === session?.participantIdentity,
        });
      });
  }

  function isCurrent(epoch: number): boolean {
    return !disposed && epoch === lifecycleEpoch;
  }

  function invalidateLifecycle(): number {
    lifecycleEpoch += 1;
    cancelRosterRefresh?.();
    cancelRosterRefresh = null;
    abortSessionRequests();
    return lifecycleEpoch;
  }

  function abortSessionRequests(): void {
    for (const controller of sessionRequests) controller.abort();
    sessionRequests.clear();
  }

  async function requestVoiceSession(epoch: number): Promise<Response | null> {
    if (!isCurrent(epoch)) return null;
    const abortController = new AbortController();
    sessionRequests.add(abortController);
    try {
      const response = await fetcher(
        `/api/games/${encodeURIComponent(options.gameId)}/voice-session`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          cache: "no-store",
          signal: abortController.signal,
        },
      );
      return isCurrent(epoch) ? response : null;
    } finally {
      sessionRequests.delete(abortController);
    }
  }

  function refreshRoster(epoch: number): Promise<void> {
    if (!isCurrent(epoch) || !session || !room) return Promise.resolve();
    if (rosterRefresh) {
      rosterRefreshQueued = true;
      return rosterRefresh;
    }
    const currentSession = session;
    const currentRoom = room;
    const nextRefresh = (async () => {
      try {
        const response = await requestVoiceSession(epoch);
        if (!response || !isCurrent(epoch) || room !== currentRoom) return;
        if (!response.ok) {
          await failClosedRosterRefresh(epoch, currentRoom);
          return;
        }
        const responseValue = await response.json();
        if (!isCurrent(epoch) || room !== currentRoom) return;
        const refreshed = parseVoiceSession(responseValue);
        if (
          !refreshed ||
          refreshed.participantIdentity !== currentSession.participantIdentity ||
          refreshed.serverUrl !== currentSession.serverUrl
        ) {
          await failClosedRosterRefresh(epoch, currentRoom);
          return;
        }
        session = Object.freeze({
          ...currentSession,
          participants: refreshed.participants,
        });
        syncAuthorizedSubscriptions();
        publish({ error: null, participants: participantSnapshot() });
        armRosterRefresh(epoch);
      } catch {
        if (isCurrent(epoch) && room === currentRoom) {
          await failClosedRosterRefresh(epoch, currentRoom);
        }
      }
    })();
    rosterRefresh = nextRefresh;
    void nextRefresh.finally(() => {
      if (rosterRefresh !== nextRefresh) return;
      rosterRefresh = null;
      if (rosterRefreshQueued && isCurrent(epoch) && room === currentRoom) {
        rosterRefreshQueued = false;
        void refreshRoster(epoch);
      } else {
        rosterRefreshQueued = false;
      }
    });
    return nextRefresh;
  }

  function armRosterRefresh(epoch: number): void {
    if (!scheduleRosterRefresh || !isCurrent(epoch) || !room) return;
    cancelRosterRefresh?.();
    cancelRosterRefresh = scheduleRosterRefresh(() => {
      cancelRosterRefresh = null;
      if (isCurrent(epoch) && room) void refreshRoster(epoch);
    }, 20_000);
  }

  async function failClosedRosterRefresh(
    epoch: number,
    currentRoom: Room,
  ): Promise<void> {
    if (!isCurrent(epoch) || room !== currentRoom) return;
    const failureEpoch = invalidateLifecycle();
    const disconnected = await disconnectActiveRoom("failed", failureEpoch, currentRoom);
    if (!isCurrent(failureEpoch)) return;
    publish({
      status: "failed",
      microphoneEnabled: disconnected ? false : snapshot.microphoneEnabled,
      error: disconnected
        ? "Voice authorization could not be refreshed. Live voice was disconnected."
        : "Voice authorization changed. Incoming audio stopped, but the voice connection could not close cleanly.",
      participants: disconnected ? [] : participantSnapshot(),
    });
  }

  async function setMicrophoneEnabled(enabled: boolean): Promise<void> {
    const activeRoom = room;
    const sdk = liveKit;
    const epoch = lifecycleEpoch;
    if (!activeRoom || !session || !sdk || !isCurrent(epoch)) return;
    if (enabled) publish({ status: "requesting_permission", error: null });

    let commandError: unknown = null;
    try {
      await activeRoom.localParticipant.setMicrophoneEnabled(
        enabled,
        enabled
          ? {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            }
          : undefined,
      );
    } catch (error) {
      commandError = error;
    }

    if (!isCurrent(epoch) || room !== activeRoom) {
      const microphoneOff = await ensureMicrophoneOff(activeRoom, sdk);
      if (!microphoneOff) await disconnectLateRoom(activeRoom, sdk);
      return;
    }

    if (
      enabled &&
      commandError === null &&
      isMicrophoneDefinitelyOn(activeRoom, sdk)
    ) {
      publish({
        microphoneEnabled: true,
        status: "joined_live",
        error: null,
        participants: participantSnapshot(),
      });
      return;
    }

    if (enabled && commandError === null) {
      commandError = new Error("Microphone activation was not confirmed.");
    }

    const microphoneOff = commandError === null && isMicrophoneDefinitelyOff(activeRoom, sdk)
      ? true
      : await ensureMicrophoneOff(activeRoom, sdk);
    if (!isCurrent(epoch) || room !== activeRoom) {
      if (!microphoneOff) await disconnectLateRoom(activeRoom, sdk);
      return;
    }
    if (!microphoneOff) {
      await disconnectForMicrophoneSafety(activeRoom);
      return;
    }

    if (!enabled) {
      publish({
        microphoneEnabled: false,
        status: "joined_muted",
        error: null,
        participants: participantSnapshot(),
      });
      return;
    }
    publish({
      microphoneEnabled: false,
      status: isPermissionError(commandError) ? "permission_denied" : "failed",
      error: isPermissionError(commandError)
        ? "Microphone access was not allowed. You can stay and listen."
        : "The microphone could not start. You can stay and listen.",
      participants: participantSnapshot(),
    });
  }

  async function ensureMicrophoneOff(
    targetRoom: Room,
    sdk: typeof import("livekit-client"),
  ): Promise<boolean> {
    const localParticipant = targetRoom.localParticipant;
    const knownTracks = new Set<NonNullable<LocalTrackPublication["track"]>>();
    for (const publication of microphonePublications(targetRoom, sdk)) {
      if (publication.track) knownTracks.add(publication.track);
    }
    try {
      await localParticipant.setMicrophoneEnabled(false);
    } catch {
      // Continue through the stronger unpublish-and-stop fallback below.
    }
    if (isMicrophoneDefinitelyOff(targetRoom, sdk, knownTracks)) return true;

    for (const publication of microphonePublications(targetRoom, sdk)) {
      const track = publication.track;
      if (track) knownTracks.add(track);
      try {
        await publication.mute();
      } catch {
        // Unpublishing and stopping still provide independent shutdown paths.
      }
      if (!track) continue;
      try {
        await localParticipant.unpublishTrack(track, true);
      } catch {
        // The local capture is stopped below even if server unpublish fails.
      }
      track.stop();
    }
    return isMicrophoneDefinitelyOff(targetRoom, sdk, knownTracks);
  }

  function microphonePublications(
    targetRoom: Room,
    sdk: typeof import("livekit-client"),
  ): LocalTrackPublication[] {
    return [...targetRoom.localParticipant.trackPublications.values()]
      .filter((publication) => publication.source === sdk.Track.Source.Microphone);
  }

  function isMicrophoneDefinitelyOff(
    targetRoom: Room,
    sdk: typeof import("livekit-client"),
    knownTracks: ReadonlySet<NonNullable<LocalTrackPublication["track"]>> = new Set(),
  ): boolean {
    const publications = microphonePublications(targetRoom, sdk);
    const publicationsSafe = publications.every((publication) => {
      const track = publication.track;
      return publication.isMuted && (!track || localTrackIsOff(track));
    });
    return !targetRoom.localParticipant.isMicrophoneEnabled &&
      publicationsSafe &&
      [...knownTracks].every(localTrackIsOff);
  }

  function isMicrophoneDefinitelyOn(
    targetRoom: Room,
    sdk: typeof import("livekit-client"),
  ): boolean {
    return targetRoom.localParticipant.isMicrophoneEnabled &&
      microphonePublications(targetRoom, sdk).some((publication) => {
        const track = publication.track;
        return Boolean(
          !publication.isMuted &&
          track &&
          !track.isMuted &&
          track.mediaStreamTrack.readyState === "live" &&
          track.mediaStreamTrack.enabled,
        );
      });
  }

  function localTrackIsOff(track: NonNullable<LocalTrackPublication["track"]>): boolean {
    return track.isMuted ||
      track.mediaStreamTrack.readyState === "ended" ||
      !track.mediaStreamTrack.enabled;
  }

  async function disconnectForMicrophoneSafety(targetRoom: Room): Promise<void> {
    const safetyEpoch = invalidateLifecycle();
    const disconnected = await disconnectActiveRoom("failed", safetyEpoch, targetRoom);
    if (!isCurrent(safetyEpoch)) return;
    publish({
      status: "failed",
      microphoneEnabled: disconnected ? false : true,
      error: disconnected
        ? "The microphone could not be turned off safely, so live voice was disconnected."
        : "Microphone shutdown could not be confirmed. Leave this table or close the browser to stop voice.",
      participants: disconnected ? [] : participantSnapshot(),
    });
  }

  async function disconnectActiveRoom(
    finalStatus: LiveVoiceStatus,
    epoch: number,
    expectedRoom: Room | null = room,
  ): Promise<boolean> {
    const activeRoom = expectedRoom;
    const activeSession = session;
    const sdk = liveKit;
    if (!activeRoom) {
      cleanupDetachedMedia();
      if (isCurrent(epoch)) {
        publish({
          status: finalStatus,
          microphoneEnabled: false,
          audioPlaybackBlocked: false,
          participants: [],
        });
      }
      return true;
    }

    quiesceRemoteMedia(activeRoom);
    const microphoneOff = sdk ? await ensureMicrophoneOff(activeRoom, sdk) : false;
    let disconnected = false;
    try {
      await activeRoom.disconnect(true);
      disconnected = true;
    } catch {
      disconnected = false;
    }
    cleanupDetachedMedia();
    activeSpeakerIds.clear();
    if (disconnected && room === activeRoom) {
      room = null;
      session = null;
      liveKit = null;
    } else if (!disconnected && room === activeRoom) {
      session = activeSession;
      liveKit = sdk;
    }
    if (isCurrent(epoch)) {
      publish({
        status: disconnected ? finalStatus : "failed",
        microphoneEnabled: disconnected || microphoneOff
          ? false
          : true,
        audioPlaybackBlocked: false,
        participants: disconnected ? [] : participantSnapshot(),
        error: disconnected
          ? snapshot.error
          : microphoneOff
            ? "Live voice could not disconnect cleanly. Retry leaving the voice session."
            : "Microphone shutdown could not be confirmed. Leave this table or close the browser to stop voice.",
      });
    }
    return disconnected;
  }

  async function disconnectLateRoom(
    lateRoom: Room,
    sdk: typeof import("livekit-client") | null,
  ): Promise<void> {
    quiesceRemoteMedia(lateRoom);
    const microphoneOff = sdk ? await ensureMicrophoneOff(lateRoom, sdk) : false;
    let disconnected = false;
    try {
      await lateRoom.disconnect(true);
      disconnected = true;
    } catch {
      disconnected = false;
    }
    if (disconnected && room === lateRoom) {
      room = null;
      session = null;
      liveKit = null;
    } else if (!disconnected && !microphoneOff && !disposed) {
      publish({
        status: "failed",
        microphoneEnabled: true,
        error: "Microphone shutdown could not be confirmed. Leave this table or close the browser to stop voice.",
      });
    }
  }

  function quiesceRemoteMedia(targetRoom: Room): void {
    for (const element of audioElements) element.muted = true;
    for (const track of [...attachedRemoteTracks.keys()]) {
      try {
        detachRemoteAudio(track);
      } catch {
        attachedRemoteTracks.delete(track);
      }
    }
    for (const participant of targetRoom.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        try {
          publication.setSubscribed(false);
        } catch {
          // Muting and detaching local playback above remains fail-closed.
        }
      }
    }
    cleanupDetachedMedia();
  }

  function cleanupDetachedMedia(): void {
    for (const element of audioElements) element.remove();
    audioElements.clear();
    attachedRemoteTracks.clear();
  }

  return controller;
}

function parseVoiceSession(value: unknown): VoiceSessionResponse | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "expiresAt,participantIdentity,participants,provider,serverUrl,token") {
    return null;
  }
  let serverUrl: URL;
  try {
    serverUrl = new URL(typeof value.serverUrl === "string" ? value.serverUrl : "");
  } catch {
    return null;
  }
  if (
    value.provider !== "livekit" ||
    typeof value.serverUrl !== "string" ||
    serverUrl.protocol !== "wss:" ||
    Boolean(serverUrl.username || serverUrl.password) ||
    serverUrl.pathname !== "/" ||
    Boolean(serverUrl.search || serverUrl.hash) ||
    typeof value.token !== "string" ||
    value.token.length < 32 ||
    value.token.length > 8_192 ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= Date.now() ||
    value.expiresAt > Date.now() + 10 * 60_000 ||
    typeof value.participantIdentity !== "string" ||
    !Array.isArray(value.participants) ||
    value.participants.length < 1 ||
    value.participants.length > 6
  ) {
    return null;
  }
  const participants: SessionParticipant[] = [];
  for (const participant of value.participants) {
    if (!isRecord(participant)) return null;
    if (Object.keys(participant).sort().join(",") !== "displayName,identity,playerId") return null;
    if (
      typeof participant.identity !== "string" ||
      !/^osp_[a-f0-9]{32}$/.test(participant.identity) ||
      typeof participant.playerId !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/u.test(participant.playerId) ||
      typeof participant.displayName !== "string" ||
      participant.displayName.length < 1 ||
      participant.displayName.length > 48
    ) {
      return null;
    }
    participants.push(Object.freeze({
      identity: participant.identity,
      playerId: participant.playerId,
      displayName: participant.displayName,
    }));
  }
  if (!participants.some((participant) => participant.identity === value.participantIdentity)) {
    return null;
  }
  return Object.freeze({
    provider: "livekit",
    serverUrl: value.serverUrl,
    token: value.token,
    expiresAt: value.expiresAt,
    participantIdentity: value.participantIdentity,
    participants: Object.freeze(participants),
  });
}

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const value = await response.json();
    if (!isRecord(value) || !isRecord(value.error)) return null;
    return typeof value.error.code === "string" ? value.error.code : null;
  } catch {
    return null;
  }
}

function isPermissionError(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "SecurityError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
