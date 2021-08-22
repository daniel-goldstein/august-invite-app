import august from 'august-connect'
import express from 'express'
import { v4 as uuidv4 } from 'uuid'
import https from 'https'
import { Datastore } from '@google-cloud/datastore'

require('dotenv').config();

const LOCK_ID = process.env.LOCK_ID

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID

const DOMAIN = process.env.DOMAIN || 'localhost'
const PORT = process.env.PORT || 3000
const PROTOCOL = process.env.PROTOCOL || 'http'
const BASE_PATH = DOMAIN === 'localhost' ? `${PROTOCOL}://localhost:${PORT}` : `${PROTOCOL}://${DOMAIN}`

const datastore = new Datastore()
const app = express()

async function saveInvite(inviteToken: string, invite) {
  const key = datastore.key(['Invite', inviteToken])
  await datastore.save({ key, data: invite })
}

async function createInvite(maxEntries, guestName) {
  const token = uuidv4()
  let expiration = new Date()
  expiration.setFullYear(2030)

  const invite = { expiration, maxEntries, guestName }
  await saveInvite(token, invite)
  return { token, invite }
}

async function getInvite(inviteToken) {
  const entities = await datastore.get(datastore.key(['Invite', inviteToken]))
  return entities[0]
}

function sendTelegram(message) {
  const data = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: message
  })

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    }
  }

  const req = https.request(options, res => {
    res.on('data', process.stdout.write.bind(process.stdout))
  })

  req.on('error', console.error)
  req.write(data)
  req.end()
}

function entryMessage(invite) {
  return `${invite.guestName} has entered!`
}

function inviteUrl(token) {
  return `${BASE_PATH}/welcome/${token}`
}

function knockMessage(inviteToken) {
  return `Someone's at the door! Click on ${inviteUrl(inviteToken)} to let them in.`
}

function inviteMessage(inviteToken, invite) {
  const { maxEntries, expiration, guestName } = invite

  return `Here's the invite link for ${guestName}:
${inviteUrl(inviteToken)}
They are permitted a maximum of ${maxEntries} entries.
The link expires ${expiration}.`
}

async function recordEntry(inviteToken, invite) {
  invite.maxEntries--
  console.log(`Invite for token ${inviteToken}: ${invite}`)
  await saveInvite(inviteToken, invite)
}

async function getActiveInvites() {
  const query = datastore
    .createQuery('Invite')
    .filter('maxEntries', '>', 0)

  // For "performance reasons", datastore doesn't allow
  // inequality filtering on more than one property
  // so we do it in here
  const results = (await datastore.runQuery(query))[0]
  const now = new Date()
  return results.filter(invite => invite.expiration > now)
}

function activeInvitesMessage(invites) {
  if (invites.length == 0) {
    return 'No active invites. Get more friends!'
  }

  return `The active invites are:
${
invites.map(invite => {
  return `${invite.guestName}
--------------------
GUID: ${invite[datastore.KEY].name.substring(0, 5)}-XXXXX
Remaining Entries: ${invite.maxEntries}
Expiration: ${invite.expiration}
`
}).join('\n')
}
`
}

app.get('/active_invites', async function (_req, res) {
  sendTelegram(activeInvitesMessage(await getActiveInvites()))
  res.send('reported active invites')
})

app.get('/invite/:guestName/:maxEntries', async function (req, res) {
  const guestName = req.params.guestName
  const maxEntries = req.params.maxEntries
  const { token, invite } = await createInvite(maxEntries, guestName)
  sendTelegram(inviteMessage(token, invite))
  res.send('invite requested')
})

app.get('/welcome/:inviteToken', function (req, res) {
  const inviteToken = req.params.inviteToken
  const html = `<!DOCTYPE html>
<html>
<style>
.btn {
  display:block;
  width:800px;
  height:800px;
  line-height:80%;
  border: 2px solid #f5f5f5;
  border-radius: 50%;
  color:#f5f5f5;
  text-align:center;
  text-decoration:none;
  background: #555777;
  box-shadow: 0 0 3px gray;
  font-size:150px;
  font-weight:bold;
}
.btn:hover {
    background: #ff0000;
}
</style>
<body>
    <form action="${inviteUrl(inviteToken)}" method="post">
      <button class='btn' type="submit">Unlock</button>
    </form>
</body>
</html>
`
  res.send(html)
})

app.post('/welcome/:inviteToken', async function (req, res) {
  const inviteToken = req.params.inviteToken
  const invite = await getInvite(inviteToken)

  if (!invite) {
    res.send('no')
    return
  }

  if (invite.expiration < new Date()) {
    res.send('expired')
    return
  }
  if (invite.maxEntries == 0) {
    res.send('used up all entries')
    return
  }

  await recordEntry(inviteToken, invite)
  sendTelegram(entryMessage(invite))
  august.unlock({ lockID: LOCK_ID })
  res.send(`Welcome ${invite.guestName}`)
})

app.get('/knock', function (_req, res) {
  const html = `<!DOCTYPE html>
<html>
<body>
  <h1>Welcome to Willow.</h1>
  <p>Please knock and hold for the next available representative.</p>
    <form action="${BASE_PATH}/knock" method="post">
        <input type="submit" value="Knock" />
    </form>
</body>
</html>
`
  res.send(html)
})

app.post('/knock', async function (_req, res) {
  const { token } = await createInvite(1, 'stranger')
  sendTelegram(knockMessage(token))
  res.send("<p>You've knocked. Please wait to be let in.</p>")
})

app.listen(PORT)