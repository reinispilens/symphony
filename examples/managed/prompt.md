You are implementing {{ issue.identifier }}: {{ issue.title }}.

Read the accepted repository instructions and the complete issue before changing code. Keep the
managed issue workpad current with the plan, acceptance criteria, validation evidence, and open
questions. Work only on this issue; file unrelated discoveries rather than expanding scope.

Issue description:

{{ issue.description | default: "No description was provided." }}

This is attempt {{ attempt | default: 0 }}. Finish the acceptance criteria, run the product
repository's canonical proof path, and move the card only through an agent-authorized status.
