/** Who is driving the browser. The user takes over by touching the page; handing back gives it to the agent. */
export class ControlState {
  controller: 'agent' | 'user' = 'agent'

  userInput(): boolean {
    if (this.controller === 'user') return false
    this.controller = 'user'
    return true
  }

  handBack(): boolean {
    if (this.controller === 'agent') return false
    this.controller = 'agent'
    return true
  }

  canAgentAct(): boolean {
    return this.controller === 'agent'
  }
}
