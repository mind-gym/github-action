// @ts-check
const { restoreCache, saveCache } = require('@actions/cache')
const core = require('@actions/core')
const exec = require('@actions/exec')
const io = require('@actions/io')
const { Octokit } = require('@octokit/core')
const hasha = require('hasha')
const fs = require('fs')
const os = require('os')
const path = require('path')
const quote = require('quote')
const cliParser = require('argument-vector')()
const findYarnWorkspaceRoot = require('find-yarn-workspace-root')
const { ping } = require('./src/ping')

/**
 * Parses input command, finds the tool and
 * the runs the command.
 */
const execCommand = (
  fullCommand,
  waitToFinish = true,
  label = 'executing'
) => {
  const cwd = cypressCommandOptions.cwd

  console.log('%s command "%s"', label, fullCommand)
  console.log('current working directory "%s"', cwd)

  const args = cliParser.parse(fullCommand)
  core.debug(`parsed command: ${args.join(' ')}`)

  return io.which(args[0], true).then((toolPath) => {
    core.debug(`found command "${toolPath}"`)
    core.debug(`with arguments ${args.slice(1).join(' ')}`)

    const toolArguments = args.slice(1)
    const argsString = toolArguments.join(' ')
    core.debug(`running ${quote(toolPath)} ${argsString} in ${cwd}`)
    core.debug(`waiting for the command to finish? ${waitToFinish}`)

    const promise = exec.exec(
      quote(toolPath),
      toolArguments,
      cypressCommandOptions
    )
    if (waitToFinish) {
      return promise
    }
  })
}

const isWindows = () => os.platform() === 'win32'
const isUrl = (s) => /^https?:\/\//.test(s)

const homeDirectory = os.homedir()
const platformAndArch = `${process.platform}-${process.arch}`

const startWorkingDirectory = process.cwd()
// seems the working directory should be absolute to work correctly
// https://github.com/cypress-io/github-action/issues/211
const workingDirectory = core.getInput('working-directory')
  ? path.resolve(core.getInput('working-directory'))
  : startWorkingDirectory
core.debug(`working directory ${workingDirectory}`)

/**
 * When running "npm install" or any other Cypress-related commands,
 * use the install directory as current working directory
 */
const cypressCommandOptions = {
  cwd: workingDirectory
}

const yarnFilename = path.join(
  findYarnWorkspaceRoot(workingDirectory) || workingDirectory,
  'yarn.lock'
)
const packageLockFilename = path.join(
  workingDirectory,
  'package-lock.json'
)

const useYarn = () => fs.existsSync(yarnFilename)

const lockHash = () => {
  const lockFilename = useYarn() ? yarnFilename : packageLockFilename
  const fileHash = hasha.fromFileSync(lockFilename)
  core.debug(`Hash from file ${lockFilename} is ${fileHash}`)
  return fileHash
}

// enforce the same NPM cache folder across different operating systems
const NPM_CACHE_FOLDER = path.join(homeDirectory, '.npm')
const getNpmCache = () => {
  const o = {}
  let key = core.getInput('cache-key')
  const hash = lockHash()
  if (!key) {
    if (useYarn()) {
      key = `yarn-${platformAndArch}-${hash}`
    } else {
      key = `npm-${platformAndArch}-${hash}`
    }
  } else {
    console.log('using custom cache key "%s"', key)
  }

  if (useYarn()) {
    o.inputPath = path.join(homeDirectory, '.cache', 'yarn')
  } else {
    o.inputPath = NPM_CACHE_FOLDER
  }

  // use exact restore key to prevent NPM cache from growing
  // https://glebbahmutov.com/blog/do-not-let-npm-cache-snowball/
  o.restoreKeys = o.primaryKey = key
  return o
}

const restoreCachedNpm = () => {
  core.debug('trying to restore cached NPM modules')
  const NPM_CACHE = getNpmCache()
  return restoreCache([NPM_CACHE.inputPath], NPM_CACHE.primaryKey, [
    NPM_CACHE.restoreKeys
  ]).catch((e) => {
    console.warn('Restoring NPM cache error: %s', e.message)
  })
}

const saveCachedNpm = () => {
  core.debug('saving NPM modules')
  const NPM_CACHE = getNpmCache()
  return saveCache([NPM_CACHE.inputPath], NPM_CACHE.primaryKey).catch(
    (e) => {
      console.warn('Saving NPM cache error: %s', e.message)
    }
  )
}

const install = () => {
  // prevent lots of progress messages during install
  core.exportVariable('CI', '1')
  // set NPM cache path in case the user has custom install command
  core.exportVariable('npm_config_cache', NPM_CACHE_FOLDER)

  // Note: need to quote found tool to avoid Windows choking on
  // npm paths with spaces like "C:\Program Files\nodejs\npm.cmd ci"
  const installCommand = core.getInput('install-command')
  if (installCommand) {
    core.debug(`using custom install command "${installCommand}"`)
    return execCommand(installCommand, true, 'install command')
  }

  if (useYarn()) {
    core.debug('installing NPM dependencies using Yarn')
    return io.which('yarn', true).then((yarnPath) => {
      core.debug(`yarn at "${yarnPath}"`)
      return exec.exec(
        quote(yarnPath),
        ['--frozen-lockfile'],
        cypressCommandOptions
      )
    })
  } else {
    core.debug('installing NPM dependencies')

    return io.which('npm', true).then((npmPath) => {
      core.debug(`npm at "${npmPath}"`)
      return exec.exec(quote(npmPath), ['ci'], cypressCommandOptions)
    })
  }
}

/**
 * Grabs a boolean GitHub Action parameter input and casts it.
 * @param {string} name - parameter name
 * @param {boolean} defaultValue - default value to use if the parameter was not specified
 * @returns {boolean} converted input argument or default value
 */
const getInputBool = (name, defaultValue = false) => {
  const param = core.getInput(name)
  if (param === 'true' || param === '1') {
    return true
  }
  if (param === 'false' || param === '0') {
    return false
  }

  return defaultValue
}

const buildAppMaybe = () => {
  const buildApp = core.getInput('build')
  if (!buildApp) {
    return
  }

  core.debug(`building application using "${buildApp}"`)

  return execCommand(buildApp, true, 'build app')
}

const startServersMaybe = () => {
  let startCommand

  if (isWindows()) {
    // allow custom Windows start command
    startCommand =
      core.getInput('start-windows') || core.getInput('start')
  } else {
    startCommand = core.getInput('start')
  }
  if (!startCommand) {
    core.debug('No start command found')
    return Promise.resolve()
  }

  // allow commands to be separated using commas or newlines
  const separateStartCommands = startCommand
    .split(/,|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  core.debug(
    `Separated ${
      separateStartCommands.length
    } start commands ${separateStartCommands.join(', ')}`
  )

  return separateStartCommands.map((startCommand) => {
    return execCommand(
      startCommand,
      false,
      `start server "${startCommand}`
    )
  })
}

/**
 * Pings give URL(s) until the timeout expires.
 * @param {string} waitOn A single URL or comma-separated URLs
 * @param {Number?} waitOnTimeout in seconds
 */
const waitOnUrl = (waitOn, waitOnTimeout = 60) => {
  console.log(
    'waiting on "%s" with timeout of %s seconds',
    waitOn,
    waitOnTimeout
  )

  const waitTimeoutMs = waitOnTimeout * 1000

  const waitUrls = waitOn
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  core.debug(`Waiting for urls ${waitUrls.join(', ')}`)

  // run every wait promise after the previous has finished
  // to avoid "noise" of debug messages
  return waitUrls.reduce((prevPromise, url) => {
    return prevPromise.then(() => {
      core.debug(`Waiting for url ${url}`)
      return ping(url, waitTimeoutMs)
    })
  }, Promise.resolve())
}

const waitOnMaybe = () => {
  const waitOn = core.getInput('wait-on')
  if (!waitOn) {
    return
  }

  const waitOnTimeout = core.getInput('wait-on-timeout') || '60'
  const timeoutSeconds = parseFloat(waitOnTimeout)

  if (isUrl(waitOn)) {
    return waitOnUrl(waitOn, timeoutSeconds)
  }

  console.log('Waiting using command "%s"', waitOn)
  return execCommand(waitOn, true)
}

const I = (x) => x

/**
 * Asks Cypress API if there were already builds for this commit.
 * In that case increments the count to get unique parallel id.
 */
const getCiBuildId = async () => {
  const {
    GITHUB_WORKFLOW,
    GITHUB_SHA,
    GITHUB_TOKEN,
    GITHUB_RUN_ID,
    GITHUB_REPOSITORY
  } = process.env

  const [owner, repo] = GITHUB_REPOSITORY.split('/')
  let branch
  let buildId = `${GITHUB_WORKFLOW} - ${GITHUB_SHA}`

  if (GITHUB_TOKEN) {
    core.debug(
      `Determining build id by asking GitHub about run ${GITHUB_RUN_ID}`
    )

    const client = new Octokit({
      auth: GITHUB_TOKEN
    })

    const resp = await client.request(
      'GET /repos/:owner/:repo/actions/runs/:run_id',
      {
        owner,
        repo,
        run_id: parseInt(GITHUB_RUN_ID)
      }
    )

    if (resp && resp.data && resp.data.head_branch) {
      branch = resp.data.head_branch
      core.debug(`found the branch name ${branch}`)
    }

    // This will return the complete list of jobs for a run with their steps,
    // this should always return data when there are jobs on the workflow.
    // Every time the workflow is re-run the jobs length should stay the same
    // (because the same amount of jobs were ran) but the id of them should change
    // letting us, select the first id as unique id
    // https://docs.github.com/en/rest/reference/actions#list-jobs-for-a-workflow-run
    const runsList = await client.request(
      'GET /repos/:owner/:repo/actions/runs/:run_id/jobs',
      {
        owner,
        repo,
        run_id: parseInt(GITHUB_RUN_ID)
      }
    )

    if (
      runsList &&
      runsList.data &&
      runsList.data.jobs &&
      runsList.data.jobs.length
    ) {
      const jobId = runsList.data.jobs[0].id
      core.debug(`fetched run list with jobId ${jobId}`)
      buildId = `${GITHUB_RUN_ID}-${jobId}`
    } else {
      core.debug('could not get run list data')
    }
  }

  core.debug(`determined branch ${branch} and build id ${buildId}`)
  return { branch, buildId }
}

/**
 * Run Cypress tests by collecting input parameters
 * and using Cypress module API to run tests.
 * @see https://on.cypress.io/module-api
 */
const runTests = async () => {
  const runTests = getInputBool('runTests', true)
  if (!runTests) {
    console.log('Skipping running tests: runTests parameter is false')
    return
  }

  core.exportVariable('TERM', 'xterm')

  const customCommand = core.getInput('command')
  if (customCommand) {
    console.log('Using custom test command: %s', customCommand)
    return execCommand(customCommand, true, 'run tests')
  }

  const commandPrefix = core.getInput('command-prefix')
  if (commandPrefix) {
    return runTestsUsingCommandLine()
  }

  const onTestsFinished = (testResults) => {
    process.chdir(startWorkingDirectory)

    if (testResults.failures) {
      console.error('Test run failed, code %d', testResults.failures)
      console.error('More information might be available above')

      return Promise.reject(
        new Error(testResults.message || 'Error running tests')
      )
    }

    const dashboardUrl = testResults.runUrl
    if (dashboardUrl) {
      core.debug(`Dashboard url ${dashboardUrl}`)
    } else {
      core.debug('There is no Dashboard url')
    }
    // we still set the output explicitly
    core.setOutput('dashboardUrl', dashboardUrl)

    if (testResults.totalFailed) {
      return Promise.reject(
        new Error(`tests: ${testResults.totalFailed} failed`)
      )
    }
  }

  const onTestsError = (e) => {
    process.chdir(startWorkingDirectory)

    console.error(e)
    return Promise.reject(e)
  }

  process.chdir(workingDirectory)
  return cypress
    .run(cypressOptions)
    .then(onTestsFinished, onTestsError)
}

const installMaybe = () => {
  const installParameter = getInputBool('install', true)
  if (!installParameter) {
    console.log('Skipping install because install parameter is false')
    return Promise.resolve()
  }

  return Promise.all([restoreCachedNpm()]).then(([npmCacheHit]) => {
    core.debug(`npm cache hit ${npmCacheHit}`)

    return install().then(() => {
      core.debug('install has finished')
    })
  })
}

installMaybe()
  .then(buildAppMaybe)
  .then(startServersMaybe)
  .then(waitOnMaybe)
  .then(runTests)
  .then(() => {
    core.debug('all done, exiting')
    // force exit to avoid waiting for child processes,
    // like the server we have started
    // see https://github.com/actions/toolkit/issues/216
    process.exit(0)
  })
  .catch((error) => {
    // final catch - when anything goes wrong, throw an error
    // and exit the action with non-zero code
    core.debug(error.message)
    core.debug(error.stack)

    core.setFailed(error.message)
    process.exit(1)
  })
