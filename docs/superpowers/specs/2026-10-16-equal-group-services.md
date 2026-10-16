# Equal services within global priority groups

This correction supersedes the within-group ordering in the earlier global-priority-groups design. The user confirmed that all services in a group are equal. Dragging remains available to change a service's group.

Interception, Follow queue and Dispensable retain their global precedence. Computer identity and row position never establish another priority inside a group. Interception and Follow queue finish the active occurrence before accepting a same-group arrival. Waiting occurrences use arrival order. Dispensable rotates all eligible services by confirmed Hold, including peers on the same computer. Higher-group interruptions preserve the original occurrence and remaining budget.

Configuration shows all computers' services. Users can drag only their own services between groups, including empty groups and groups containing foreign services. A drop within the same group does nothing. Remove position numbers and intra-group sorting. Preserve the accessible group menu, compact layout, policy drafts and ownership/revision guards.

The complete groups API validates all owned services but changes membership only. Array order has no scheduling effect. Keep legacy serviceOrder as display metadata for compatibility. Preserve production groups, IDs, credentials, epochs, Hold and live occurrences.

Verify FIFO equality, same-computer Hold rotation, inert legacy order, interruption resume and ownership. Run the complete Worker/UI suite and rendered desktop/mobile checks. Release through CI and native Cloudflare Builds, then verify the real deployment and existing registrations. Update issue35 and canonical project memory to supersede the previous own-queue guidance.
