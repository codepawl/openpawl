/**
 * Setup Step 6: Team — template selection and custom roster builder.
 */

import {
    note,
    select,
    text,
} from "@clack/prompts";
import pc from "picocolors";
import { TEAM_TEMPLATES, type RosterEntry } from "../../core/team-templates.js";
import { getRoleTemplate } from "../../core/bot-definitions.js";
import { handleCancel, type WizardState } from "./connection.js";

function formatTemplateSlots(template: { slots: Array<{ role_id: string; count: number }> }): string {
    return template.slots
        .map((slot) => {
            const role = getRoleTemplate(slot.role_id);
            const name = role?.name ?? slot.role_id;
            return `${slot.count}x ${name}`;
        })
        .join(", ");
}

async function customTeamBuilder(): Promise<RosterEntry[]> {
    const sizeInput = handleCancel(
        await text({
            message: "Total number of bots in your team?",
            initialValue: "4",
            placeholder: "4",
            validate: (v) => {
                const n = Number(v?.trim());
                if (!Number.isInteger(n) || n < 1) return "Enter an integer >= 1.";
                if (n > 200) return "Please keep team size <= 200.";
                return undefined;
            },
        }),
    ) as string;
    const totalCapacity = parseInt(sizeInput.trim(), 10) || 4;

    const roster: RosterEntry[] = [];

    while (true) {
        const currentAssigned = roster.reduce((sum, r) => sum + r.count, 0);
        const remaining = totalCapacity - currentAssigned;

        note(
            `Assigned: ${currentAssigned}/${totalCapacity} bots.\nRoster: ${
                roster.length === 0
                    ? "No roles assigned yet."
                    : roster.map((r) => `${r.count}x ${r.role}`).join(", ")
            }`,
            "Current roster",
        );

        const action = handleCancel(
            await select({
                message: "What would you like to do?",
                options: [
                    { label: "Confirm and Continue", value: "confirm" },
                    { label: "Add a custom role", value: "add" },
                    { label: "Edit a role", value: "edit" },
                    { label: "Remove a role", value: "remove" },
                ],
            }),
        ) as string;

        if (action === "confirm") {
            if (currentAssigned < totalCapacity) {
                note("Please assign all bots before confirming.", "Roster incomplete");
                continue;
            }
            if (currentAssigned > totalCapacity) {
                note("Assigned bots exceed total team size. Please reduce counts.", "Roster exceeds capacity");
                continue;
            }
            return roster;
        }

        if (action === "add") {
            if (remaining <= 0) {
                note("No remaining capacity. Edit or remove existing roles to free up bots.", "No capacity");
                continue;
            }

            const roleName = (handleCancel(
                await text({
                    message: "Role name?",
                    placeholder: "Backend Coder",
                    validate: (v) =>
                        (v ?? "").trim().length > 0 ? undefined : "Role name cannot be empty.",
                }),
            ) as string).trim();

            const description = (handleCancel(
                await text({
                    message: "Role description?",
                    placeholder: "Focuses on backend services, APIs, and data models.",
                }),
            ) as string).trim();

            const countInput = handleCancel(
                await text({
                    message: `How many bots for "${roleName}"? (Remaining: ${remaining})`,
                    initialValue: String(Math.min(remaining, 1)),
                    validate: (v) => {
                        const n = Number(v?.trim());
                        if (!Number.isInteger(n) || n < 1) return "Please enter a positive integer.";
                        if (n > remaining) return "Exceeds remaining capacity.";
                        return undefined;
                    },
                }),
            ) as string;
            const count = parseInt(countInput.trim(), 10) || 1;

            const existingIndex = roster.findIndex(
                (r) => r.role.toLowerCase() === roleName.toLowerCase(),
            );
            if (existingIndex >= 0) {
                roster[existingIndex] = {
                    ...roster[existingIndex],
                    description: description || roster[existingIndex].description,
                    count: roster[existingIndex].count + count,
                };
            } else {
                roster.push({ role: roleName, description: description || "Custom role.", count });
            }
            continue;
        }

        if (action === "edit") {
            if (roster.length === 0) {
                note("No roles to edit. Add a role first.", "Nothing to edit");
                continue;
            }

            const roleIdx = handleCancel(
                await select({
                    message: "Which role to edit?",
                    options: roster.map((r, idx) => ({
                        value: idx,
                        label: `${r.role} (${r.count} bots)`,
                    })),
                }),
            ) as number;

            const existing = roster[roleIdx];
            const newName = (handleCancel(
                await text({
                    message: `Edit role name (currently "${existing.role}")`,
                    initialValue: existing.role,
                    validate: (v) =>
                        (v ?? "").trim().length > 0 ? undefined : "Role name cannot be empty.",
                }),
            ) as string).trim();

            const newDesc = (handleCancel(
                await text({ message: "Edit description", initialValue: existing.description }),
            ) as string).trim();

            const newCountInput = handleCancel(
                await text({
                    message: `Edit bot count for "${newName}"`,
                    initialValue: String(existing.count),
                    validate: (v) => {
                        const n = Number(v?.trim());
                        if (!Number.isInteger(n) || n < 1) return "Please enter a positive integer.";
                        const hypothetical = currentAssigned - existing.count + n;
                        if (hypothetical > totalCapacity) return "Exceeds total team size.";
                        return undefined;
                    },
                }),
            ) as string;

            roster[roleIdx] = {
                role: newName,
                description: newDesc || existing.description,
                count: parseInt(newCountInput.trim(), 10) || existing.count,
            };
            continue;
        }

        if (action === "remove") {
            if (roster.length === 0) {
                note("No roles to remove.", "Nothing to remove");
                continue;
            }

            const roleIdx = handleCancel(
                await select({
                    message: "Which role to remove?",
                    options: roster.map((r, idx) => ({
                        value: idx,
                        label: `${r.role} (${r.count} bots)`,
                    })),
                }),
            ) as number;
            roster.splice(roleIdx, 1);
            continue;
        }
    }
}

export async function stepTeam(state: WizardState): Promise<void> {
    const templateEntries = Object.entries(TEAM_TEMPLATES);
    const options: Array<{ value: string; label: string; hint?: string }> = templateEntries.map(
        ([id, tmpl]) => ({
            value: id,
            label: `${tmpl.name} ${pc.dim("—")} ${tmpl.description}`,
            hint: formatTemplateSlots(tmpl),
        }),
    );
    options.push({ value: "__custom", label: "Custom..." });

    const picked = handleCancel(
        await select({
            message: "Choose a team template:",
            options,
        }),
    ) as string;

    if (picked === "__custom") {
        state.roster = await customTeamBuilder();
        state.templateId = "custom";
    } else {
        const template = TEAM_TEMPLATES[picked]!;
        state.templateId = picked;
        state.roster = template.slots.map((slot) => {
            const role = getRoleTemplate(slot.role_id);
            return {
                role: role?.name ?? slot.role_id,
                count: slot.count,
                description: role ? role.skills.join(", ") : "",
            };
        });
    }
}
