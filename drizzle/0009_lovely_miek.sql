CREATE TABLE `game_rounds` (
	`game_id` text NOT NULL,
	`completion_revision` integer NOT NULL,
	`round_number` integer NOT NULL,
	`winner_profile_id` text NOT NULL,
	`winner_display_name` text NOT NULL,
	`winner_reason` text NOT NULL,
	`completed_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `completion_revision`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_game_rounds_number` ON `game_rounds` (`game_id`,`round_number`);--> statement-breakpoint
CREATE INDEX `idx_game_rounds_winner` ON `game_rounds` (`game_id`,`winner_profile_id`);--> statement-breakpoint
WITH eligible_games AS (
	SELECT
		id AS game_id,
		version AS current_version,
		CASE
			WHEN json_valid(state_json) THEN state_json
			ELSE '{"players":[]}'
		END AS safe_state_json
	FROM games
	WHERE status = 'finished'
),
event_items AS (
	SELECT
		g.game_id,
		g.safe_state_json,
		event.version AS completion_revision,
		event.created_at AS completed_at,
		CAST(item.key AS INTEGER) AS event_index,
		CASE
			WHEN json_valid(item.value) THEN item.value
			ELSE '{}'
		END AS safe_event_json
	FROM eligible_games g
	JOIN game_events event
		ON event.game_id = g.game_id
		AND event.version BETWEEN 1 AND g.current_version
	JOIN json_each(
		CASE
			WHEN json_valid(event.public_payload_json)
				THEN event.public_payload_json
			ELSE '[]'
		END
	) item
),
current_state_players AS (
	SELECT
		event_items.*,
		CASE
			WHEN json_valid(player.value) THEN player.value
			ELSE '{}'
		END AS safe_player_json
	FROM event_items
	JOIN json_each(event_items.safe_state_json, '$.players') player
),
valid_completions AS (
	SELECT
		item.game_id,
		item.completion_revision,
		profile.id AS winner_profile_id,
		json_extract(item.safe_player_json, '$.displayName')
			AS winner_display_name,
		json_extract(item.safe_event_json, '$.data.reason')
			AS winner_reason,
		item.completed_at,
		ROW_NUMBER() OVER (
			PARTITION BY item.game_id
			ORDER BY item.completion_revision DESC, item.event_index DESC
		) AS completion_rank
	FROM current_state_players item
	JOIN profiles profile
		ON profile.auth_subject =
			json_extract(item.safe_player_json, '$.userId')
	WHERE json_extract(item.safe_event_json, '$.type') = 'game_won'
		AND json_extract(item.safe_event_json, '$.actorPlayerId') =
			json_extract(item.safe_state_json, '$.winner.playerId')
		AND json_extract(item.safe_player_json, '$.playerId') =
			json_extract(item.safe_event_json, '$.actorPlayerId')
		AND json_extract(item.safe_event_json, '$.data.reason') =
			json_extract(item.safe_state_json, '$.winner.reason')
		AND json_extract(item.safe_event_json, '$.data.reason') IN
			('empty_hand', 'last_active')
		AND typeof(
			json_extract(item.safe_player_json, '$.displayName')
		) = 'text'
		AND item.completed_at >= 0
)
INSERT OR IGNORE INTO game_rounds (
	game_id, completion_revision, round_number, winner_profile_id,
	winner_display_name, winner_reason, completed_at
)
SELECT
	game_id,
	completion_revision,
	1,
	winner_profile_id,
	winner_display_name,
	winner_reason,
	completed_at
FROM valid_completions
WHERE completion_rank = 1;
