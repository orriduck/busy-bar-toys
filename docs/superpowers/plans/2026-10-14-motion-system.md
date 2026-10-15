# Implementation plan

1. Rewrite the README with short English sentences, consistent terms, and one action per procedure step.
2. Add a reusable bicycle0 encoder, alpha masks, and cached clock/rate digit atlases. Verify binary structure and endpoints.
3. Add a non-blocking motion controller. Verify interruption, coalescing, standby timing, and stable refreshes.
4. Connect the observer, finite demos, and reduced-motion service option. Keep button and task polling active.
5. Verify real device transitions. Inspect and save sequence evidence. Restore the real observer.
6. Run local tests and CI. Update the README and motion guide with verified behavior. Push main and synchronize memory.
