image := "ghcr.io/obeli-sk/obelisk-agent-server:latest"

build:
  docker build -t {{image}} agent-server

serve:
  obelisk server run -d deployment.toml

run prompt:
  sh -c 'obelisk execution submit ${OBELISK_SUBMIT_FLAGS:-} -f obelisk-agent:workflow/workflow.run -- "{{prompt}}"'
