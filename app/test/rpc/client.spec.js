jest.mock('uuid/v4')

const WebSocket = require('ws')
const uuidV4 = require('uuid/v4')
const winston = require('winston')

const { Connection, Client, Context, RemoteObject } = require('../../rpc/client')

const log = winston

// TODO: How to import properly?
const DISPATCHED = 0
const ACKNOWLEDGED = 1
const RETURNED = 2
const CALL_RESULT_MESSAGE = 0
const CALL_ACK_MESSAGE = 1
const NOTIFICATION_MESSAGE = 2
const CONTROL_MESSAGE = 3

jest.mock('ws', () => jest.fn(() => (
  {
    handlers: new Map(),
    trigger(name, ...args) {
      return this.handlers.get(name)(...args)
    },
    send: jest.fn(s => s),
    addEventListener(name, handler) {
      this.handlers.set(name, handler)
    },
    close: jest.fn()
  }
)))

uuidV4.mockImplementation(() => 'uuid')
describe('Call Remote Method', () => {
  const s = new WebSocket()
  const sendMock = s.send.mock
  const context = Context(s)
  const promise = context.callRemoteMethod(42, 'func', [1, 2])

  it('ws.send called once', () => {
    expect(sendMock.calls).toHaveLength(1)
  })

  it('arguments passed and set', () => {
    const args = JSON.parse(sendMock.calls[0])
    expect(args.id).toEqual('uuid')
    expect(args.name).toEqual('func')
    expect(args.that).toEqual(42)
    expect(args.args).toEqual([1, 2])
  })

  it('call added to pending calls', () => {
    expect(context.pendingCalls.size).toEqual(1)
    const handle = context.pendingCalls.get('uuid').handle
    expect(context.pendingCalls.get('uuid')).toEqual({ handle, state: DISPATCHED, timer: 1 })
  })

  it('completes successful call sequence', async () => {
    context.dispatch({ $meta: { id: 'uuid', type: CALL_ACK_MESSAGE } })
    expect(context.pendingCalls.get('uuid').state).toEqual(ACKNOWLEDGED)
    context.dispatch({ $meta: { id: 'uuid', type: CALL_RESULT_MESSAGE }, str: 'hi!' })
    const res = await promise
    expect(context.pendingCalls.size).toEqual(0)
    expect(res).toEqual({ $meta: { id: 'uuid', type: CALL_RESULT_MESSAGE }, str: 'hi!' })
  })
})

describe('Connect and receive root object proxy', () => {
  const { promise, socket } = Connection('ws://127.0.0.1')
  process.nextTick(() => socket.trigger('open'))

  it('returns connection once socket is open', async () => {
    const conn = await promise
    expect(conn).toEqual(socket)
  })

  it('instantiates client and receives remote proxy', async () => {
    const conn = await promise
    const client = Client(conn, _ => _)
    process.nextTick(() => socket.trigger(
      'message',
      { data: JSON.stringify({
        Foo: { a: { int: 1 }, b: { int: 2 } },
        $meta: { type: CONTROL_MESSAGE, that: 42 }
      }) }
    ))
    const res = await client
    expect(res).toEqual({ a: 1, b: 2 })
  })
})

describe('Create remote object proxy', () => {
  const { socket } = Connection('ws://127.0.0.1')
  process.nextTick(() => socket.trigger('open'))
  const context = Context(socket)
  const obj = {
    $meta: { that: 42 },
    Foo: { a: { int: 3 }, b: { int: 4 } }
  }
  const res = RemoteObject(context, obj)

  it('accepts remote object', () => {
    expect(context.instances.has(42)).toEqual(true)
    expect(res.a).toEqual(3)
    expect(res).toEqual({ a: 3, b: 4 })
  })

  it('accepts nested objects', () => {
    const newObj = {
      $meta: { that: 42 },
      Foo: {
        a: { int: 3 },
        b: { $meta: { that: 33 }, Bar: { s: { str: 'hi' } } } }
    }
    const newRes = RemoteObject(context, newObj)
    expect(newRes).toEqual({ a: 3, b: { s: 'hi' } })
  })

  it('updates remote values for existing proxies', () => {
    expect(res).toEqual({ a: 3, b: { s: 'hi' } })
  })

  it('dispatches a call to nested object', () => {
    res.b.test(1, 2, 3)
    expect(JSON.parse(socket.send.mock.calls.pop())).toEqual(
      { args: [1, 2, 3], id: 'uuid', name: 'test', that: 33 }
    )
  })

  it('handles arrays and dictionaries', () => {
    const newObj = {
      $meta: { that: 42 },
      Foo: {
        a: { dict:
        {
          a: { int: 1 },
          b: { int: 2 },
          c: { array:
            [{ int: 1 }, { $meta: { that: 100 }, Bar: { a: { int: 5 } } }] }
        } }
      }
    }
    const newRes = RemoteObject(context, newObj)
    expect(newRes).toEqual({ a: { a: 1, b: 2, c: [1, { a: 5 }] } })
  })

  it('dispatches call to remote object in nested array', () => {
    res.a.c[1].foo('hi!')
    expect(JSON.parse(socket.send.mock.calls.pop())).toEqual(
      { args: ['hi!'], id: 'uuid', name: 'foo', that: 100 }
    )
  })
})