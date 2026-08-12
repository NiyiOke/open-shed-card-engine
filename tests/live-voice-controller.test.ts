import assert from "node:assert/strict";
import test from "node:test";
import {
  RoomEvent,
  Track,
  type RemoteParticipant,
  type Room,
} from "livekit-client";
import {
  createLiveVoiceController,
  type LiveVoiceSnapshot,
} from "../app/components/live-voice";

const SELF_IDENTITY = "osp_0123456789abcdef0123456789abcdef";
const REMOTE_IDENTITY = "osp_fedcba9876543210fedcba9876543210";
const REMOTE_TWO_IDENTITY = "osp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("joining voice is listen-only and microphone capture requires a second explicit action", async () => {
  const fakeRoom = new FakeRoom();
  const snapshots: LiveVoiceSnapshot[] = [];
  const controller = createLiveVoiceController({
    gameId: "game-safe",
    fetcher: async () => Response.json(sessionPayload()),
    createRoom: () => fakeRoom as unknown as Room,
    documentRef: null,
    onChange: (snapshot) => snapshots.push(snapshot),
  });

  controller.markAvailable();
  controller.openPrejoin();
  await controller.join();

  assert.equal(fakeRoom.connected, true);
  assert.equal(fakeRoom.connectOptions?.autoSubscribe, false);
  assert.deepEqual(fakeRoom.microphoneRequests, []);
  assert.equal(controller.getSnapshot().status, "joined_muted");
  assert.equal(controller.getSnapshot().microphoneEnabled, false);

  await controller.setMicrophoneEnabled(true);
  assert.deepEqual(fakeRoom.microphoneRequests, [true]);
  assert.equal(controller.getSnapshot().status, "joined_live");
  assert.equal(controller.getSnapshot().microphoneEnabled, true);

  await controller.leave();
  assert.deepEqual(fakeRoom.microphoneRequests, [true, false]);
  assert.equal(fakeRoom.disconnected, true);
  assert.equal(controller.getSnapshot().status, "ended");
  assert.ok(snapshots.some((snapshot) => snapshot.status === "prejoin"));
});

test("permission denial keeps the room listenable and never claims a live microphone", async () => {
  const fakeRoom = new FakeRoom();
  fakeRoom.permissionDenied = true;
  const controller = createLiveVoiceController({
    gameId: "game-safe",
    fetcher: async () => Response.json(sessionPayload()),
    createRoom: () => fakeRoom as unknown as Room,
    documentRef: null,
  });
  controller.markAvailable();
  await controller.join();
  await controller.setMicrophoneEnabled(true);
  assert.equal(controller.getSnapshot().status, "permission_denied");
  assert.equal(controller.getSnapshot().microphoneEnabled, false);
  assert.match(controller.getSnapshot().error ?? "", /not allowed/iu);
  assert.deepEqual(fakeRoom.microphoneRequests, [true, false]);
});

test("disabled or malformed sessions fail closed before a room or microphone is created", async () => {
  let created = 0;
  const disabled = createLiveVoiceController({
    gameId: "game-safe",
    fetcher: async () => Response.json(
      { error: { code: "LIVE_VOICE_UNAVAILABLE", message: "Unavailable" } },
      { status: 404 },
    ),
    createRoom: () => {
      created += 1;
      return new FakeRoom() as unknown as Room;
    },
    documentRef: null,
  });
  disabled.markAvailable();
  await disabled.join();
  assert.equal(disabled.getSnapshot().status, "unavailable");
  assert.equal(created, 0);

  const malformed = createLiveVoiceController({
    gameId: "game-safe",
    fetcher: async () => Response.json({ token: "private-token-canary" }),
    createRoom: () => {
      created += 1;
      return new FakeRoom() as unknown as Room;
    },
    documentRef: null,
  });
  malformed.markAvailable();
  await malformed.join();
  assert.equal(malformed.getSnapshot().status, "failed");
  assert.equal(created, 0);
});

test("dispose aborts a deferred session request and no late response creates a room", async () => {
  const responseGate = deferred<Response>();
  const requestSignals: AbortSignal[] = [];
  let roomsCreated = 0;
  const controller = createLiveVoiceController({
    gameId: "game-safe",
    fetcher: async (_input, init) => {
      requestSignals.push(init?.signal as AbortSignal);
      return responseGate.promise;
    },
    createRoom: () => {
      roomsCreated += 1;
      return new FakeRoom() as unknown as Room;
    },
    documentRef: null,
  });

  const joining = controller.join();
  await eventually(() => requestSignals.length === 1);
  await controller.dispose();
  assert.equal(requestSignals[0]?.aborted, true);
  responseGate.resolve(Response.json(sessionPayload()));
  await joining;
  assert.equal(roomsCreated, 0);
});

test("dispose during a deferred SDK import never constructs or connects a room", async () => {
  const importGate = deferred<typeof import("livekit-client")>();
  let importStarted = false;
  let roomsCreated = 0;
  const controller = createLiveVoiceController({
    gameId: "game-safe",
    fetcher: async () => Response.json(sessionPayload()),
    loadLiveKit: () => {
      importStarted = true;
      return importGate.promise;
    },
    createRoom: () => {
      roomsCreated += 1;
      return new FakeRoom() as unknown as Room;
    },
    documentRef: null,
  });

  const joining = controller.join();
  await eventually(() => importStarted);
  await controller.dispose();
  importGate.resolve(await import("livekit-client"));
  await joining;
  assert.equal(roomsCreated, 0);
});

test("dispose during a deferred room connect disconnects any late connection", async () => {
  const connectGate = deferred<void>();
  const fakeRoom = new FakeRoom();
  fakeRoom.connectGate = connectGate;
  const controller = createLiveVoiceController({
    gameId: "game-safe",
    fetcher: async () => Response.json(sessionPayload()),
    createRoom: () => fakeRoom as unknown as Room,
    documentRef: null,
  });

  const joining = controller.join();
  await eventually(() => fakeRoom.connectStarted);
  await controller.dispose();
  assert.ok(fakeRoom.disconnectCount >= 1);
  connectGate.resolve();
  await joining;
  assert.equal(fakeRoom.connected, false);
  assert.ok(fakeRoom.disconnectCount >= 2);
});

test("an unprovable mute failure disconnects instead of claiming the microphone is off", async () => {
  const fakeRoom = new FakeRoom();
  const controller = createLiveVoiceController({
    gameId: "game-safe",
    fetcher: async () => Response.json(sessionPayload()),
    createRoom: () => fakeRoom as unknown as Room,
    documentRef: null,
  });
  await controller.join();
  await controller.setMicrophoneEnabled(true);
  fakeRoom.makeMicrophoneShutdownUnsafe();

  await controller.setMicrophoneEnabled(false);

  assert.equal(fakeRoom.connected, false);
  assert.equal(fakeRoom.disconnected, true);
  assert.equal(controller.getSnapshot().status, "failed");
  assert.equal(controller.getSnapshot().microphoneEnabled, false);
  assert.match(controller.getSnapshot().error ?? "", /disconnected/iu);
});

test("leave during deferred unmute never reports an unconfirmed microphone as off", async () => {
  const enableGate = deferred<void>();
  const fakeRoom = new FakeRoom();
  fakeRoom.enableGate = enableGate;
  const controller = createLiveVoiceController({
    gameId: "game-safe",
    fetcher: async () => Response.json(sessionPayload()),
    createRoom: () => fakeRoom as unknown as Room,
    documentRef: null,
  });
  await controller.join();

  const enabling = controller.setMicrophoneEnabled(true);
  await eventually(() => fakeRoom.localParticipant.isMicrophoneEnabled);
  fakeRoom.makeMicrophoneShutdownUnsafe();
  fakeRoom.disconnectFailure = true;

  await controller.leave();
  assert.equal(fakeRoom.connected, true);
  assert.equal(controller.getSnapshot().status, "failed");
  assert.equal(controller.getSnapshot().microphoneEnabled, true);
  assert.match(controller.getSnapshot().error ?? "", /shutdown could not be confirmed/iu);

  enableGate.resolve();
  await enabling;
  assert.equal(controller.getSnapshot().microphoneEnabled, true);
  assert.match(controller.getSnapshot().error ?? "", /shutdown could not be confirmed/iu);
});

test("leave detaches and mutes incoming audio before deferred provider shutdown completes", async () => {
  const disableGate = deferred<void>();
  const fakeRoom = new FakeRoom();
  const remoteElement = new FakeAudioElement();
  const remoteTrack = new FakeRemoteTrack(remoteElement);
  const remotePublication = new FakeRemotePublication(remoteTrack);
  const remoteParticipant = new FakeRemoteParticipant(REMOTE_IDENTITY, remotePublication);
  fakeRoom.remoteParticipants.set(
    REMOTE_IDENTITY,
    remoteParticipant as unknown as RemoteParticipant,
  );
  const fakeDocument = new FakeDocument();
  const controller = createLiveVoiceController({
    gameId: "game-safe",
    fetcher: async () => Response.json(sessionPayload([{
      identity: REMOTE_IDENTITY,
      playerId: "player-remote",
      displayName: "Remote Alias",
    }])),
    createRoom: () => fakeRoom as unknown as Room,
    documentRef: fakeDocument as unknown as Document,
    scheduleRosterRefresh: () => () => undefined,
  });
  await controller.join();
  fakeRoom.emit(RoomEvent.TrackSubscribed, remoteTrack, remotePublication, remoteParticipant);
  assert.equal(fakeDocument.appended.length, 1);
  fakeRoom.disableGate = disableGate;

  const leaving = controller.leave();
  assert.equal(remoteElement.muted, true);
  assert.equal(remoteElement.removed, true);
  assert.equal(remoteTrack.detachCount, 1);

  disableGate.resolve();
  await leaving;
});

test("a late participant stays unsubscribed until a refreshed server roster authorizes them", async () => {
  const fakeRoom = new FakeRoom();
  const remotePublication = new FakeRemotePublication();
  const remoteParticipant = new FakeRemoteParticipant(REMOTE_IDENTITY, remotePublication);
  let requests = 0;
  const controller = createLiveVoiceController({
    gameId: "game-safe",
    fetcher: async () => {
      requests += 1;
      return Response.json(
        sessionPayload(
          requests === 1
            ? []
            : [{
                identity: REMOTE_IDENTITY,
                playerId: "player-remote",
                displayName: "Remote Alias",
              }],
        ),
      );
    },
    createRoom: () => fakeRoom as unknown as Room,
    documentRef: null,
  });
  await controller.join();
  fakeRoom.remoteParticipants.set(
    REMOTE_IDENTITY,
    remoteParticipant as unknown as RemoteParticipant,
  );

  fakeRoom.emit(RoomEvent.ParticipantConnected, remoteParticipant);
  assert.deepEqual(remotePublication.subscriptionRequests, [false]);
  assert.equal(controller.getSnapshot().participants.some(
    (participant) => participant.playerId === "player-remote",
  ), false);

  await eventually(() => controller.getSnapshot().participants.some(
    (participant) => participant.playerId === "player-remote",
  ));
  assert.equal(requests, 2);
  assert.deepEqual(remotePublication.subscriptionRequests, [false, true]);
});

test("periodic authoritative refresh unsubscribes a removed participant", async () => {
  const scheduler = new ManualScheduler();
  const fakeRoom = new FakeRoom();
  const remotePublication = new FakeRemotePublication();
  const remoteParticipant = new FakeRemoteParticipant(REMOTE_IDENTITY, remotePublication);
  fakeRoom.remoteParticipants.set(
    REMOTE_IDENTITY,
    remoteParticipant as unknown as RemoteParticipant,
  );
  let requests = 0;
  const controller = createLiveVoiceController({
    gameId: "game-safe",
    fetcher: async () => {
      requests += 1;
      return Response.json(sessionPayload(
        requests === 1
          ? [{
              identity: REMOTE_IDENTITY,
              playerId: "player-remote",
              displayName: "Remote Alias",
            }]
          : [],
      ));
    },
    createRoom: () => fakeRoom as unknown as Room,
    documentRef: null,
    scheduleRosterRefresh: scheduler.schedule,
  });
  await controller.join();
  assert.deepEqual(remotePublication.subscriptionRequests, [true]);
  assert.equal(controller.getSnapshot().participants.some(
    (participant) => participant.playerId === "player-remote",
  ), true);

  scheduler.runNext();
  await eventually(() => requests === 2);
  await eventually(() => !controller.getSnapshot().participants.some(
    (participant) => participant.playerId === "player-remote",
  ));
  assert.deepEqual(remotePublication.subscriptionRequests, [true, false]);
});

test("coalesced roster changes schedule one follow-up so a second valid late join is not stranded", async () => {
  const firstRefresh = deferred<Response>();
  const secondRefresh = deferred<Response>();
  const fakeRoom = new FakeRoom();
  const firstPublication = new FakeRemotePublication();
  const secondPublication = new FakeRemotePublication();
  const firstParticipant = new FakeRemoteParticipant(REMOTE_IDENTITY, firstPublication);
  const secondParticipant = new FakeRemoteParticipant(REMOTE_TWO_IDENTITY, secondPublication);
  let requests = 0;
  const controller = createLiveVoiceController({
    gameId: "game-safe",
    fetcher: async () => {
      requests += 1;
      if (requests === 1) return Response.json(sessionPayload());
      return requests === 2 ? firstRefresh.promise : secondRefresh.promise;
    },
    createRoom: () => fakeRoom as unknown as Room,
    documentRef: null,
  });
  await controller.join();
  fakeRoom.remoteParticipants.set(
    REMOTE_IDENTITY,
    firstParticipant as unknown as RemoteParticipant,
  );
  fakeRoom.emit(RoomEvent.ParticipantConnected, firstParticipant);
  await eventually(() => requests === 2);
  fakeRoom.remoteParticipants.set(
    REMOTE_TWO_IDENTITY,
    secondParticipant as unknown as RemoteParticipant,
  );
  fakeRoom.emit(RoomEvent.ParticipantConnected, secondParticipant);

  firstRefresh.resolve(Response.json(sessionPayload([{
    identity: REMOTE_IDENTITY,
    playerId: "player-remote",
    displayName: "Remote Alias",
  }])));
  await eventually(() => requests === 3);
  secondRefresh.resolve(Response.json(sessionPayload([
    {
      identity: REMOTE_IDENTITY,
      playerId: "player-remote",
      displayName: "Remote Alias",
    },
    {
      identity: REMOTE_TWO_IDENTITY,
      playerId: "player-two",
      displayName: "Second Alias",
    },
  ])));

  await eventually(() => controller.getSnapshot().participants.some(
    (participant) => participant.playerId === "player-two",
  ));
  assert.deepEqual(firstPublication.subscriptionRequests, [false, true, true]);
  assert.deepEqual(secondPublication.subscriptionRequests, [false, false, true]);
});

function sessionPayload(
  additionalParticipants: ReadonlyArray<{
    identity: string;
    playerId: string;
    displayName: string;
  }> = [],
) {
  return {
    provider: "livekit",
    serverUrl: "wss://open-shed-test.livekit.cloud",
    token: "test-token-that-is-long-enough-to-pass-the-parser",
    expiresAt: Date.now() + 300_000,
    participantIdentity: SELF_IDENTITY,
    participants: [
      {
        identity: SELF_IDENTITY,
        playerId: "player-safe",
        displayName: "Table Alias",
      },
      ...additionalParticipants,
    ],
  } as const;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

class FakeLocalTrack {
  isMuted = false;
  preventStop = false;
  mediaStreamTrack = {
    enabled: true,
    readyState: "live",
  };

  stop(): void {
    if (this.preventStop) return;
    this.isMuted = true;
    this.mediaStreamTrack.enabled = false;
    this.mediaStreamTrack.readyState = "ended";
  }
}

class FakeLocalPublication {
  source = Track.Source.Microphone;
  isMuted = false;
  muteFailure = false;
  track = new FakeLocalTrack();

  async mute(): Promise<void> {
    if (this.muteFailure) throw new Error("mute failed");
    this.isMuted = true;
    this.track.isMuted = true;
    this.track.mediaStreamTrack.enabled = false;
  }
}

class FakeAudioElement {
  autoplay = false;
  muted = false;
  hidden = false;
  removed = false;
  dataset: Record<string, string> = {};

  remove(): void {
    this.removed = true;
  }
}

class FakeRemoteTrack {
  kind = Track.Kind.Audio;
  detachCount = 0;

  constructor(private readonly element: FakeAudioElement) {}

  attach(): FakeAudioElement {
    return this.element;
  }

  detach(): FakeAudioElement[] {
    this.detachCount += 1;
    return [this.element];
  }
}

class FakeRemotePublication {
  source = Track.Source.Microphone;
  track: FakeRemoteTrack | undefined;
  isMuted = true;
  subscriptionRequests: boolean[] = [];

  constructor(track?: FakeRemoteTrack) {
    this.track = track;
  }

  setSubscribed(subscribed: boolean): void {
    this.subscriptionRequests.push(subscribed);
  }
}

class FakeDocument {
  appended: FakeAudioElement[] = [];
  body = {
    appendChild: (element: FakeAudioElement) => {
      this.appended.push(element);
      return element;
    },
  };
}

class ManualScheduler {
  private jobs: Array<{ callback: () => void; cancelled: boolean }> = [];

  schedule = (callback: () => void, delayMs: number): (() => void) => {
    assert.equal(delayMs, 20_000);
    const job = { callback, cancelled: false };
    this.jobs.push(job);
    return () => {
      job.cancelled = true;
    };
  };

  runNext(): void {
    const job = this.jobs.find((candidate) => !candidate.cancelled);
    assert.ok(job, "expected a scheduled roster refresh");
    job.cancelled = true;
    job.callback();
  }
}

class FakeRemoteParticipant {
  audioTrackPublications = new Map<string, FakeRemotePublication>();
  trackPublications = this.audioTrackPublications;

  constructor(
    readonly identity: string,
    publication: FakeRemotePublication,
  ) {
    this.audioTrackPublications.set("remote-microphone", publication);
  }

  getTrackPublication(): FakeRemotePublication | undefined {
    return this.audioTrackPublications.get("remote-microphone");
  }
}

class FakeRoom {
  connected = false;
  disconnected = false;
  permissionDenied = false;
  disableFailure = false;
  unpublishFailure = false;
  microphoneRequests: boolean[] = [];
  remoteParticipants = new Map<string, RemoteParticipant>();
  connectGate: ReturnType<typeof deferred<void>> | null = null;
  enableGate: ReturnType<typeof deferred<void>> | null = null;
  disableGate: ReturnType<typeof deferred<void>> | null = null;
  connectStarted = false;
  connectOptions: { autoSubscribe?: boolean } | null = null;
  disconnectCount = 0;
  disconnectFailure = false;
  private handlers = new Map<string, Array<(...args: never[]) => void>>();
  private microphonePublication: FakeLocalPublication | null = null;
  localParticipant: {
    identity: string;
    isMicrophoneEnabled: boolean;
    trackPublications: Map<string, FakeLocalPublication>;
    getTrackPublication: () => FakeLocalPublication | undefined;
    setMicrophoneEnabled: (enabled: boolean) => Promise<undefined>;
    unpublishTrack: (track: FakeLocalTrack, stopOnUnpublish?: boolean) => Promise<undefined>;
  };

  constructor() {
    const trackPublications = new Map<string, FakeLocalPublication>();
    this.localParticipant = {
      identity: SELF_IDENTITY,
      isMicrophoneEnabled: false,
      trackPublications,
      getTrackPublication: () => this.microphonePublication ?? undefined,
      setMicrophoneEnabled: async (enabled) => {
        this.microphoneRequests.push(enabled);
        if (enabled && this.permissionDenied) {
          throw new DOMException("Denied", "NotAllowedError");
        }
        if (!enabled && this.disableFailure) throw new Error("disable failed");
        if (!enabled && this.disableGate) await this.disableGate.promise;
        if (enabled) {
          this.localParticipant.isMicrophoneEnabled = true;
          this.microphonePublication = new FakeLocalPublication();
          trackPublications.set("local-microphone", this.microphonePublication);
          if (this.enableGate) await this.enableGate.promise;
        } else if (this.microphonePublication) {
          this.localParticipant.isMicrophoneEnabled = false;
          this.microphonePublication.isMuted = true;
          this.microphonePublication.track.isMuted = true;
          this.microphonePublication.track.mediaStreamTrack.enabled = false;
        }
        return undefined;
      },
      unpublishTrack: async (track, stopOnUnpublish = true) => {
        if (this.unpublishFailure) throw new Error("unpublish failed");
        trackPublications.delete("local-microphone");
        this.microphonePublication = null;
        this.localParticipant.isMicrophoneEnabled = false;
        if (stopOnUnpublish) track.stop();
        return undefined;
      },
    };
  }

  on(event: string, handler: (...args: never[]) => void): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args as never[]);
    }
  }

  async connect(
    _serverUrl: string,
    _token: string,
    options: { autoSubscribe?: boolean },
  ): Promise<void> {
    this.connectStarted = true;
    this.connectOptions = options;
    if (this.connectGate) await this.connectGate.promise;
    this.connected = true;
    this.disconnected = false;
  }

  async startAudio(): Promise<void> {}

  async disconnect(stopTracks = true): Promise<void> {
    this.disconnectCount += 1;
    if (this.disconnectFailure) throw new Error("disconnect failed");
    this.connected = false;
    this.disconnected = true;
    if (stopTracks) {
      for (const publication of this.localParticipant.trackPublications.values()) {
        publication.track.stop();
      }
    }
  }

  makeMicrophoneShutdownUnsafe(): void {
    this.disableFailure = true;
    this.unpublishFailure = true;
    if (!this.microphonePublication) throw new Error("microphone is not live");
    this.microphonePublication.muteFailure = true;
    this.microphonePublication.track.preventStop = true;
  }
}
