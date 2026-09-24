import { ROOM_ALIAS_MAX_LENGTH } from "./public-discovery";
import { useEffect, useRef, useState } from "react";
import type { LobbyInvite, LobbyPresencePlayer, LobbyPresenceSnapshot } from "./lobby-presence";

export type LobbyInviteResponseAction = "accept" | "decline" | "decline_and_block";

export function LobbyPresencePanel({ snapshot, alias, busy, error, status, focusRequest, setAlias, setLooking, respondToInvite }: {
  snapshot: LobbyPresenceSnapshot;
  alias: string;
  busy: boolean;
  error: string | null;
  status: string | null;
  focusRequest: number;
  setAlias: (value: string) => void;
  setLooking: (looking: boolean) => void;
  respondToInvite: (invite: LobbyInvite, action: LobbyInviteResponseAction) => void;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [confirmInviteBlockId, setConfirmInviteBlockId] = useState<string | null>(null);
  const inviteBlockTriggerRef = useRef<HTMLButtonElement | null>(null);
  const confirmInviteBlockButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (confirmInviteBlockId) confirmInviteBlockButtonRef.current?.focus();
  }, [confirmInviteBlockId]);
  useEffect(() => {
    if (focusRequest > 0) sectionRef.current?.focus({ preventScroll: true });
  }, [focusRequest]);
  const cancelInviteBlock = () => {
    setConfirmInviteBlockId(null);
    window.requestAnimationFrame(() => inviteBlockTriggerRef.current?.focus());
  };
  return <section ref={sectionRef} tabIndex={-1} className="lobby-presence-panel" aria-labelledby="lobby-presence-title">
    <div className="section-heading lobby-presence-heading"><div>
      <span className="eyebrow">Opt-in player lobby</span><h2 id="lobby-presence-title">Looking for a game?</h2>
      <p>Choose a public lobby alias to receive invitations. Your account name is never used.</p>
    </div>{snapshot.self.lookingForGame ? <button className="secondary-button" disabled={busy} onClick={() => setLooking(false)}>Stop looking</button> : null}</div>
    {snapshot.self.lookingForGame ? <div className="lobby-presence-active">
      <span className="presence-chip presence-live">Online as {snapshot.self.alias}</span>
      <p>Visibility expires within a minute if this page stops checking in or you enter a table.</p>
    </div> : <div className="lobby-presence-opt-in">
      <label className="input-label" htmlFor="lobby-presence-alias"><span>Public lobby alias</span><input id="lobby-presence-alias" value={alias} maxLength={ROOM_ALIAS_MAX_LENGTH} autoComplete="off" placeholder="Choose a new alias" aria-describedby="lobby-presence-disclosure" onChange={(event) => setAlias(event.target.value)} /></label>
      <p id="lobby-presence-disclosure" className="dialog-privacy-note">This starts blank. Avoid your real name. Only opted-in players and eligible hosts see the alias and a coarse connection status.</p>
      <button className="primary-button acid" disabled={busy || !alias.trim()} onClick={() => setLooking(true)}>{busy ? "Saving…" : "Show me as looking"}</button>
    </div>}
    {snapshot.invites.length ? <div className="incoming-lobby-invites" aria-labelledby="incoming-invites-title"><p className="sr-only" role="status">{snapshot.invites.length === 1 ? "One new table invitation." : `${snapshot.invites.length} table invitations.`}</p><h3 id="incoming-invites-title">Table invitations</h3>{snapshot.invites.map((invite) => <article key={invite.inviteId} className="incoming-lobby-invite">
      <div><strong>{invite.fromAlias}</strong><span>invited you to a waiting table</span></div><div className="incoming-invite-actions">
        <button className="primary-button acid" aria-label={`Accept invitation from ${invite.fromAlias}`} disabled={busy} onClick={() => respondToInvite(invite, "accept")}>Accept</button><button className="secondary-button" aria-label={`Decline invitation from ${invite.fromAlias}`} disabled={busy} onClick={() => respondToInvite(invite, "decline")}>Decline</button><button className="text-button" aria-label={`Decline and block ${invite.fromAlias}`} disabled={busy || confirmInviteBlockId === invite.inviteId} aria-expanded={confirmInviteBlockId === invite.inviteId} onClick={(event) => { inviteBlockTriggerRef.current = event.currentTarget; setConfirmInviteBlockId(invite.inviteId); }}>Decline &amp; block</button>{confirmInviteBlockId === invite.inviteId ? <div className="lobby-presence-block-confirmation" role="group" aria-label={`Block ${invite.fromAlias}`}><span>Decline and block this player across Open Shed? This is a lasting safety action that prevents matchmaking and communication between you.</span><button ref={confirmInviteBlockButtonRef} className="secondary-button" disabled={busy} onClick={() => respondToInvite(invite, "decline_and_block")}>Confirm block</button><button className="text-button" disabled={busy} onClick={cancelInviteBlock}>Cancel</button></div> : null}
      </div></article>)}</div> : null}
    {snapshot.self.lookingForGame ? <div className="lobby-presence-peers" aria-labelledby="lobby-presence-peers-title"><h3 id="lobby-presence-peers-title">Invitations are on</h3><p>Only a verified host waiting alone at a table can see your public alias and invite you. Other seekers are not shown here.</p><p>Create a table to browse players who chose to be visible.</p></div> : null}
    {error ? <p className="field-error lobby-presence-feedback" role="alert">{error}</p> : null}<p className="lobby-presence-feedback" aria-live="polite">{status}</p>
  </section>;
}

export function LobbyPresenceDirectory({ players, busy, status, error, focusRequest, invite, block }: {
  players: LobbyPresencePlayer[];
  busy: boolean;
  status: string | null;
  error: string | null;
  focusRequest: number;
  invite: (player: LobbyPresencePlayer, trigger: HTMLButtonElement) => void;
  block: (player: LobbyPresencePlayer) => void;
}) {
  const [confirmBlockId, setConfirmBlockId] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const blockTriggerRef = useRef<HTMLButtonElement | null>(null);
  const confirmBlockButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (confirmBlockId) confirmBlockButtonRef.current?.focus();
  }, [confirmBlockId]);
  useEffect(() => {
    if (focusRequest > 0) sectionRef.current?.focus({ preventScroll: true });
  }, [focusRequest]);
  const cancelBlock = () => {
    setConfirmBlockId(null);
    window.requestAnimationFrame(() => blockTriggerRef.current?.focus());
  };
  return <section ref={sectionRef} tabIndex={-1} className="lobby-presence-directory" aria-labelledby="available-players-title">
    <div className="lobby-presence-directory-heading"><div><span className="eyebrow">Opted-in now</span><h2 id="available-players-title">Players looking for a game</h2></div><p>Only public aliases and coarse connection status are shown.</p></div>
    {players.length ? <ul className="lobby-presence-list">{players.map((player) => <li key={player.presenceId}><div><strong>{player.alias}</strong><span className={`presence-chip presence-${player.status === "online" ? "live" : "reconnecting"}`}>{player.status === "online" ? "Online" : "Reconnecting"}</span></div><div className="lobby-presence-safety-actions"><button className="secondary-button" aria-label={player.inviteState === "sent" ? `Invitation sent to ${player.alias}` : `Invite ${player.alias}`} disabled={busy || player.inviteState === "sent"} onClick={(event) => invite(player, event.currentTarget)}>{player.inviteState === "sent" ? "Invited" : "Invite"}</button><button className="text-button" aria-label={`Hide and block ${player.alias}`} disabled={busy || confirmBlockId === player.presenceId} aria-expanded={confirmBlockId === player.presenceId} onClick={(event) => { blockTriggerRef.current = event.currentTarget; setConfirmBlockId(player.presenceId); }}>Hide &amp; block</button>{confirmBlockId === player.presenceId ? <div className="lobby-presence-block-confirmation" role="group" aria-label={`Block ${player.alias}`}><span>Hide and block this player across Open Shed? This is a lasting safety action that prevents matchmaking and communication between you.</span><button ref={confirmBlockButtonRef} className="secondary-button" disabled={busy} onClick={() => block(player)}>Confirm block</button><button className="text-button" disabled={busy} onClick={cancelBlock}>Cancel</button></div> : null}</div></li>)}</ul> : <div className="empty-room"><strong>No opted-in players right now.</strong><span>Share your link or check again shortly.</span></div>}
    {error ? <p className="field-error lobby-presence-feedback" role="alert">{error}</p> : null}<p className="lobby-presence-feedback" aria-live="polite">{status}</p>
  </section>;
}
