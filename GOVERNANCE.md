# Open Shed governance

Open Shed welcomes public issues, design discussion, playtesting feedback, and
pull requests. The project is currently maintained by [@NiyiOke](https://github.com/NiyiOke),
who acts as the project maintainer and release owner.

## How decisions are made

- Contributors propose changes through public issues and pull requests.
- The maintainer considers player value, rules consistency, accessibility,
  privacy, security, performance, maintainability, and project scope.
- Discussion and passing automation inform a decision but do not guarantee that
  a contribution will be accepted.
- The maintainer has final approval responsibility and may ask for revisions,
  defer a proposal, or close work that does not fit the project's direction.

## Pull requests and approval

Changes to the default branch must arrive through a pull request. Before merge:

1. Required continuous-integration checks must pass.
2. Review conversations must be resolved.
3. The project maintainer must approve the final revision.

Contributors cannot merge or deploy their own pull requests. Submitting a pull
request does not grant access to production systems or private player data.

Never put live table codes or join links, player identities, private hands, chat
content, authentication data, secrets, or sensitive logs in issues, pull
requests, commits, test fixtures, screenshots, or recordings. Use synthetic data
and redact evidence before sharing it publicly. Report security and privacy
vulnerabilities through the repository's private reporting channel.

## Releases and deployments

The maintainer decides version numbers, release timing, release notes, production
configuration, and deployment approval. A merged change may be included in a
later release rather than deployed immediately. Production credentials and
operational access are not shared through the public contribution process.

## Contribution licensing

The project is licensed under Apache-2.0. In line with section 5 of that license,
intentional contributions submitted for inclusion are provided under
Apache-2.0 unless the contributor explicitly states otherwise in writing. Each
contributor is responsible for ensuring they have the right to submit their work
and any included assets or dependencies.

## Evolving governance

As the contributor community grows, the maintainer may add trusted reviewers or
maintainers and document their responsibilities here. Changes to this governance
model are proposed and reviewed through the same pull-request process.
