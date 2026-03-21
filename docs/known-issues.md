# Known Issues

## Node 25.x background worker edge case

`kkcode` mitigates this much better now, but Node 25 still is not the preferred runtime for longagent/background-worker heavy usage.

Recommendation:

- use Node 22.x for the most stable experience
- treat Node 25.x as usable but not the baseline recommendation

## Browser OAuth metadata gaps

Some OAuth-capable providers still need provider-specific authorize/token metadata before browser login is fully automatic.

Recommended entry point:

```bash
kkcode auth onboard <provider>
```

If onboarding reports a metadata gap, follow the emitted `next:` guidance.
