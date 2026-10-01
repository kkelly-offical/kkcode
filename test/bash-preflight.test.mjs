import test from 'node:test'
import assert from 'node:assert/strict'
import {hasUnjoinedPosixBackground,assertBashLifecycle,validateBashPreflight} from '../src/kernel/tool/bash-preflight.mjs'

test('literal top-level POSIX async lists need an explicit lifecycle owner',()=>{
  for(const command of [
    'node server.mjs &',
    'cd /workspace/app && PORT=8080 ./scripts/start-backend.sh > /tmp/log 2>&1 &\necho "PID=$!"',
    'one & two & sleep 1; curl http://127.0.0.1:8080/health',
    '(node server.mjs) &','wait; (node server.mjs) &',
    'node server.mjs & echo wait',
    'one & two & wait -n'
  ])assert.equal(hasUnjoinedPosixBackground(command,{platform:'linux'}),true,command)
})

test('quoted data, redirections, joined work and CMD sequential commands remain available',()=>{
  for(const command of [
    'echo "a&b"',"printf '%s' 'a&b'",'echo a\\&b',
    'node --test suite.mjs && echo done','node --test suite.mjs 2>&1',
    'cat <&0','node one.mjs & wait','node one.mjs & wait; echo done','(node one.mjs) & wait',
    'one & p1=$!; two & p2=$!; wait "$p1" "$p2"',
    'one & wait\n','echo done # node unused.mjs &',
    'cat <<EOF\nnot-a-command &\nEOF',
    'echo "$(printf \'data &\')"','echo ${NAME:-a&b}'
  ])assert.equal(hasUnjoinedPosixBackground(command,{platform:'linux'}),false,command)
  assert.equal(hasUnjoinedPosixBackground('echo first & echo second',{platform:'win32'}),false)
})

test('preflight localizes remediation and cannot be selected by a forged builtin name',()=>{
  for(const language of ['en','zh'])assert.throws(()=>assertBashLifecycle({command:'node server.mjs &'},{platform:'linux',language}),error=>{
    assert.equal(error.code,'bash_background_requires_owner')
    assert.match(error.message,/node --test/)
    assert.match(error.message,/run_in_background/)
    assert.match(error.message,language==='zh'?/未执行/:/not executed/)
    return true
  })
  assert.doesNotThrow(()=>validateBashPreflight({name:'bash',source:'builtin'},{command:'node server.mjs &'},{platform:'linux'}))
})
