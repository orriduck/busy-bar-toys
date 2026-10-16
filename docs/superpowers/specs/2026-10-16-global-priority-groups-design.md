# Global priority groups

User explicitly requested implementation and production configuration in one pass. This supersedes global priority inferred from each computer's list index. All services remain visible; computers can move and reorder only their own services.

Three global groups, highest first:
- Interception: immediately interrupts lower groups. Current work in this group stays until source completion or its finite duration; same-group arrivals queue.
- Follow queue: plays queued work without same-group preemption; higher groups interrupt and it resumes afterward. Within each computer use its service order; alternate eligible computers fairly at completed-message boundaries.
- Dispensable: background status, visible when higher groups are empty. Rotate eligible computers by confirmed Hold time without ending source occurrences. Within a computer, use its own group service order; a later service must not jump ahead of a live earlier service.

Service groups outrank source urgency: a sender cannot publish an urgent message in Dispensable and jump above Interception. Source lifetime, urgency action semantics, withdrawal fences, native confirmation accounting and fallback proof remain valid. Same-group source-ended Follow queue work can block later work until its host ends it; do not falsely estimate its completion.

Configuration remains a compact list/detail workspace. The list is grouped globally, showing short computer IDs and all services. Own rows can drag across group headers/empty groups and reorder among that computer's rows. Other computers' rows remain selectable but immovable. Provide a library menu for accessible group moves. Mobile retains list-to-detail navigation and no horizontal overflow. Use existing Base UI/shadcn, dnd-kit, Tailwind, GSAP and Number Flow.

Protocol: service.priorityGroup is interception | follow-queue | dispensable. POST /api/services/order accepts a complete groups mapping for the requesting computer and expectedRevision. Legacy serviceIds input remains ownership checked and changes only order, preserving groups. New registration may specify priorityGroup; default agents to Dispensable, other templates to Follow queue. Snapshot exposes the group; numeric legacy priority remains inert.

One-time migration assigns missing groups, including owner-authorized cross-computer initial configuration: c2903b6c Page service17e03307-7374-4021-a7ae-58c165ba8d6e -> Interception; Claude565505c4-4c29-4d24-82e0-f97d1659156c and local Codexbf0706b2-6ffc-4996-9454-61740d92c7b8 -> Dispensable; all remaining current services -> Follow queue. Preserve per-computer relative order within each group and every existing ID, credential, epoch, Hold and live occurrence. Repeated startup must not reset subsequent user changes.

Verification: deterministic scheduling and ownership tests first; database startup persistence; mocked Chrome pointer/keyboard cross-group moves, foreign-row refusal, saved policy reload, empty groups, desktop/mobile overflow and themes; full CI and independent spec/quality reviews; native Cloudflare release and authenticated production snapshot confirming all 11 services' groups and unchanged credentials/configuration. Update issue35's obsolete tier guidance and canonical project memory after verified release.
