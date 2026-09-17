// Turns an array of parsed save results (from parser.js) into per-country timelines.
// Pure JS, no browser/Node-specific APIs.

// HOI4 dates are "YYYY.M.D.H" — plain string comparison breaks month/day ordering
// (e.g. "1936.10.21" would sort before "1936.2.5"), so always compare via this key.
function dateSortKey(dateStr) {
	if (!dateStr) return 0;
	const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(dateStr);
	if (!m) return 0;
	const [, y, mo, d, h] = m.map(Number);
	return y * 1e6 + mo * 1e4 + d * 1e2 + h;
}

function buildCountryTimeline(saves, tag) {
	// saves: array of parseSave() results, already sorted ascending by dateSortKey.
	const focusEvents = []; // { date, id, kind: 'completed' | 'in_progress' }
	const ppSeries = []; // { date, political_power }
	const ppEvents = []; // { date, kind: 'idea_adopted' | 'idea_removed', label } — laws vs. other
	// national spirits get split apart at render time using law-ideas.json, not here.
	const researchSnapshots = []; // { date, inProgress: [{id, points}] }
	const productionSnapshots = []; // { date, lines: {military_lines:[...], ...} }
	// { date, kind: 'new_equipment' | 'established_before_tracking' | 'factory_jump',
	//   lineType, equipmentId, from?, to?, delta? } — deliberately kept in raw-id form here,
	// same as advisor/idea events; resolving an equipmentId to an archetype name/category
	// (and deciding whether that's a brand-new CATEGORY vs. just a new variant within one
	// already seen) needs the equipment roster + equipment-categories.json, which are
	// render-layer/runtime data this module doesn't depend on — see index.template.html.
	const productionEvents = [];
	let researchDone = null; // filled from the latest save that has this country

	const advisorEvents = []; // { date, kind: 'appointed' | 'appointed_before_tracking' | 'dismissed', characterId, slot }
	const focusTreeEras = []; // { treeId, fromDate, toDate } — a country can switch its active
	// focus tree mid-game (e.g. France: french_focus until capitulation, then free_french_focus),
	// so this records every era observed across the loaded saves, not just the latest one.
	let prevCompleted = null; // last save's raw completed list — used only to detect newly-completed ids
	let accumulatedCompleted = null; // monotonic union across every save ever seen — never shrinks,
	// even if a country switches focus trees mid-game and a later save's own completed list only
	// reflects its new tree (France: french_focus -> free_french_focus/vichy_french_focus is
	// exactly this case — losing the old tree's completions when that happens was a real bug).
	let prevIdeas = null;
	let prevAdvisors = null;
	let prevFactoryCounts = null; // Map<equipmentId, {lineType, factories}> from the previous
	// save that had a production section — a country's production lines can also just
	// disappear (line finished/cancelled) without that being a "change" worth flagging, so
	// this only ever tracks appearances and factory-count growth, never removals.
	const FACTORY_JUMP_THRESHOLD = 10; // user's own bar: "2 digit factory increases"

	// { date, kind: 'established_before_tracking' | 'new_template' | 'count_changed',
	//   templateId, name, count?, from?, to? } — a country's division-template roster barely
	// changes month to month (a template built once might sit at the same division count for
	// a year), so this is an EVENT log (only fires when a template first appears or its
	// current division count actually changes), not a full snapshot per save — scrolling
	// through 40 identical months to find the 2 that mattered isn't useful.
	const armyEvents = [];
	let prevArmyCounts = null; // Map<templateId, {name, count}> from the previous save that had army data
	const everActiveTemplateIds = new Set(); // ids that have EVER had count > 0 in any save seen
	// so far — a template that was always sitting at 0 divisions isn't notable when it's
	// eventually cleaned up, but one that WAS active (even if disbanded down to 0 first,
	// THEN deleted later — the common sequence) should still get a closing "deleted" event;
	// checking only the immediately-preceding save's count missed exactly that sequence.

	for (const save of saves) {
		const c = save.countries[tag];
		if (!c) continue;
		const date = save.date;

		if (c.focus) {
			const completedSet = new Set(c.focus.completed);
			if (prevCompleted) {
				for (const id of completedSet) {
					if (!prevCompleted.has(id)) {
						focusEvents.push({ date, id, kind: "completed" });
					}
				}
			} else {
				// First snapshot we have for this country: no prior point to diff against,
				// so we can't say exactly when these were completed, only that they were
				// done by this date. Record them as a single "known by" baseline.
				for (const id of completedSet) {
					focusEvents.push({ date, id, kind: "completed_before_tracking" });
				}
			}
			prevCompleted = completedSet;
			if (!accumulatedCompleted) accumulatedCompleted = new Set();
			for (const id of completedSet) accumulatedCompleted.add(id);
			if (c.focus.current) {
				focusEvents.push({ date, id: c.focus.current, kind: "in_progress", progress: c.focus.progress });
			}
		}

		if (c.politics) {
			if (c.politics.political_power !== null) {
				ppSeries.push({ date, political_power: c.politics.political_power });
			}
			const ideaSet = new Set(c.politics.ideas || []);
			if (prevIdeas) {
				for (const id of ideaSet) {
					if (!prevIdeas.has(id)) ppEvents.push({ date, kind: "idea_adopted", label: id });
				}
				for (const id of prevIdeas) {
					if (!ideaSet.has(id)) ppEvents.push({ date, kind: "idea_removed", label: id });
				}
			}
			prevIdeas = ideaSet;
		}

		if (c.advisors) {
			const bySlot = new Map(c.advisors.map((a) => [a.characterId, a.slot]));
			const idSet = new Set(bySlot.keys());
			if (prevAdvisors) {
				for (const id of idSet) {
					if (!prevAdvisors.has(id)) advisorEvents.push({ date, kind: "appointed", characterId: id, slot: bySlot.get(id) });
				}
				for (const id of prevAdvisors) {
					if (!idSet.has(id)) advisorEvents.push({ date, kind: "dismissed", characterId: id, slot: null });
				}
			} else {
				for (const id of idSet) advisorEvents.push({ date, kind: "appointed_before_tracking", characterId: id, slot: bySlot.get(id) });
			}
			prevAdvisors = idSet;
		}

		if (c.technology) {
			researchSnapshots.push({ date, inProgress: c.technology.inProgress });
			// Keep the union of all "done" entries seen (a later save is a superset, but
			// merging across saves is cheap insurance and self-corrects if one snapshot
			// happened to be captured mid-write). Every tech a country starts the campaign
			// already knowing is recorded with date == the save's own start_date — those
			// aren't things anyone "researched", just the starting tech set, so drop them
			// rather than clutter the timeline with dozens of day-one entries.
			if (!researchDone) researchDone = new Map();
			for (const t of c.technology.done) {
				if (t.date && t.date === save.startDate) continue;
				if (!researchDone.has(t.id)) researchDone.set(t.id, t);
			}
		}

		if (c.production) {
			productionSnapshots.push({ date, lines: c.production, factories: c.factories || null });

			// Sum active_factories per equipment_id across every line type — the same
			// equipment can have more than one production line running at once (e.g. a
			// second line queued alongside the first), and what matters for "is this
			// country investing more in X" is the total factory count for that equipment,
			// not any one line in isolation.
			const factoryTotals = new Map();
			for (const lineType of Object.keys(c.production)) {
				for (const line of c.production[lineType]) {
					if (line.equipment_id === null || line.equipment_id === undefined) continue;
					const factories = line.active_factories || 0;
					const existing = factoryTotals.get(line.equipment_id);
					if (existing) existing.factories += factories;
					else factoryTotals.set(line.equipment_id, { lineType, factories });
				}
			}

			for (const [equipmentId, { lineType, factories }] of factoryTotals) {
				if (!prevFactoryCounts) {
					// First snapshot we have: can't say exactly when this line was started,
					// only that it existed by this date — same "before_tracking" treatment
					// as focus/advisor baselines.
					productionEvents.push({ date, kind: "established_before_tracking", lineType, equipmentId, factories });
					continue;
				}
				const prevEntry = prevFactoryCounts.get(equipmentId);
				if (!prevEntry) {
					productionEvents.push({ date, kind: "new_equipment", lineType, equipmentId, factories });
				} else if (factories - prevEntry.factories >= FACTORY_JUMP_THRESHOLD) {
					productionEvents.push({
						date,
						kind: "factory_jump",
						lineType,
						equipmentId,
						from: prevEntry.factories,
						to: factories,
						delta: factories - prevEntry.factories,
					});
				}
			}
			prevFactoryCounts = factoryTotals;
		}

		if (c.armyTemplates) {
			const currentCounts = new Map(c.armyTemplates.map((tpl) => [tpl.id, { name: tpl.name, count: tpl.count }]));
			if (!prevArmyCounts) {
				for (const [id, tpl] of currentCounts) {
					if (tpl.count > 0) {
						armyEvents.push({ date, kind: "established_before_tracking", templateId: id, name: tpl.name, count: tpl.count });
						everActiveTemplateIds.add(id);
					}
				}
			} else {
				for (const [id, tpl] of currentCounts) {
					const prev = prevArmyCounts.get(id);
					if (!prev) {
						if (tpl.count > 0) {
							armyEvents.push({ date, kind: "new_template", templateId: id, name: tpl.name, count: tpl.count });
							everActiveTemplateIds.add(id);
						}
					} else if (prev.count !== tpl.count) {
						armyEvents.push({ date, kind: "count_changed", templateId: id, name: tpl.name, from: prev.count, to: tpl.count });
						if (tpl.count > 0) everActiveTemplateIds.add(id);
					}
				}
				// A template can also disappear from the registry ENTIRELY (the player deleted
				// it in the designer, not just disbanded its divisions) — without this, a
				// template that once had an event pointing to it would vanish from the current
				// list with no explanation of why it's no longer there. Gated on
				// everActiveTemplateIds, not prevTpl.count (which only reflects the LAST known
				// count) — a template disbanded to 0 first and deleted later still needs its
				// closing event; checking only the immediately-preceding save missed that case.
				for (const [id, prevTpl] of prevArmyCounts) {
					if (!currentCounts.has(id) && everActiveTemplateIds.has(id)) {
						armyEvents.push({ date, kind: "template_removed", templateId: id, name: prevTpl.name, count: prevTpl.count });
					}
				}
			}
			prevArmyCounts = currentCounts;
		}

		if (c.focusTreeId) {
			const lastEra = focusTreeEras[focusTreeEras.length - 1];
			if (lastEra && lastEra.treeId === c.focusTreeId) {
				lastEra.toDate = date;
			} else {
				focusTreeEras.push({ treeId: c.focusTreeId, fromDate: date, toDate: date });
			}
		}
	}

	const researchTimeline = researchDone
		? [...researchDone.values()].sort((a, b) => dateSortKey(a.date) - dateSortKey(b.date))
		: [];

	// Snapshot of "where things stand right now" (as of the last loaded save), for
	// rendering a focus-tree diagram rather than just a chronological list.
	const lastFocusDate = {};
	for (const e of focusEvents) if (e.kind === "completed" || e.kind === "completed_before_tracking") lastFocusDate[e.id] = e.date;
	const lastSaveWithCountry = [...saves].reverse().find((s) => s.countries[tag]);
	const currentFocus = lastSaveWithCountry && lastSaveWithCountry.countries[tag].focus;
	const currentAdvisors = (lastSaveWithCountry && lastSaveWithCountry.countries[tag].advisors) || [];
	const focusTreeId = (lastSaveWithCountry && lastSaveWithCountry.countries[tag].focusTreeId) || null;
	const currentArmyTemplates = (lastSaveWithCountry && lastSaveWithCountry.countries[tag].armyTemplates) || [];

	return {
		tag,
		focusEvents,
		ppSeries,
		ppEvents,
		advisorEvents,
		currentAdvisors,
		currentArmyTemplates,
		armyEvents,
		focusTreeId,
		focusTreeEras,
		researchTimeline,
		researchSnapshots,
		productionSnapshots,
		productionEvents,
		completedFocuses: accumulatedCompleted ? [...accumulatedCompleted] : [],
		completedFocusDates: lastFocusDate,
		currentFocus: currentFocus && currentFocus.current ? { id: currentFocus.current, progress: currentFocus.progress } : null,
	};
}

function buildAllTimelines(saves, tags) {
	const sorted = [...saves].sort((a, b) => a.dateSortKey - b.dateSortKey);
	const out = {};
	for (const tag of tags) {
		out[tag] = buildCountryTimeline(sorted, tag);
	}
	return { saves: sorted.map((s) => ({ date: s.date, dateSortKey: s.dateSortKey, gameUniqueId: s.gameUniqueId })), countries: out };
}

const TimelineBuilder = { buildCountryTimeline, buildAllTimelines };

if (typeof module !== "undefined" && module.exports) {
	module.exports = TimelineBuilder;
}
if (typeof self !== "undefined") {
	self.TimelineBuilder = TimelineBuilder;
}
