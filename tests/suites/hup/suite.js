/*
 * Copyright 2021 balena
 *
 * @license Apache-2.0
 */

'use strict';

const fs = require('fs');
const fse = require('fs-extra');
const { join, basename } = require('path');
const { homedir } = require('os');
const util = require('util');

// required for unwrapping images
const imagefs = require('balena-image-fs');
const stream = require('stream');
const pipeline = util.promisify(stream.pipeline);

// required to use skopeo for loading the image
const exec = util.promisify(require('child_process').exec);

// copied from the SV
// https://github.com/balena-os/balena-supervisor/blob/master/src/config/backends/config-txt.ts
// TODO: retrieve this from the SDK (requires v16.2.0) or future versions of device contracts
// https://www.balena.io/docs/reference/sdk/node-sdk/#balena.models.config.getConfigVarSchema
const supportsBootConfig = (deviceType) => {
	return (
		[
			'fincm3',
			'rt-rpi-300',
			'243390-rpi3',
			'nebra-hnt',
			'revpi-connect',
			'revpi-core-3',
		].includes(deviceType) || deviceType.startsWith('raspberry')
	);
};

const checkUnderVoltage = async (that, test) => {
	test.comment(`checking for under-voltage reports in kernel logs...`);
	let result = '';
	result = await that.worker.executeCommandInHostOS(
				`dmesg | grep -q "Under-voltage detected" ; echo $?`,
				that.link,
			);

	if (result.includes('0')) {
		test.comment(`not ok! - Under-voltage detected on device, please check power source and cable!`);
	} else {
		test.comment(`ok - No under-voltage reports in the kernel logs`);
	}
};


const enableSerialConsole = async (imagePath) => {
	const bootConfig = await imagefs.interact(imagePath, 1, async (_fs) => {
		return util
			.promisify(_fs.readFile)('/config.txt')
			.catch((err) => {
				return undefined;
			});
	});

	if (bootConfig) {
		await imagefs.interact(imagePath, 1, async (_fs) => {
			const regex = /^enable_uart=.*$/m;
			const value = 'enable_uart=1';

			console.log(`Setting ${value} in config.txt...`);

			// delete any existing instances before appending to the file
			const newConfig = bootConfig.toString().replace(regex, '');
			await util.promisify(_fs.writeFile)(
				'/config.txt',
				newConfig.concat(`\n\n${value}\n\n`),
			);
		});
	}
};

// Executes the HUP process on the DUT
const doHUP = async (that, test, mode, hostapp, target) => {
	test.comment('Sending image to DUT');
	let hupOsName = basename(hostapp);
	console.log(hupOsName)

	// send hostapp to DUT
	await that.worker.sendFile(hostapp, `/mnt/data/resin-data/`, target);
	const hostappPath = `/mnt/data/resin-data/${hupOsName}`;
	console.log(hostappPath);

	const balenaHostTmpPath = "/mnt/sysroot/inactive/balena/tmp";
	const hupLoadTmp = "/mnt/data/resin-data/tmp";

	await that.worker.executeCommandInHostOS(
		`grep -q "LOADTMP" "$(command -v hostapp-update)" || { mkdir -p "${hupLoadTmp}" "${balenaHostTmpPath}" ; mount --bind "${hupLoadTmp}" "${balenaHostTmpPath}" ; }`,
		target,
	);

	test.comment(`Starting HUP`);

	let hupLog;
	switch (mode) {
		case 'local':
			if (
				(await that.worker.executeCommandInHostOS(
						`[[ -f ${hostappPath} ]] && echo exists`,
						target,
					)) !== 'exists'
			) {
				throw new Error(`Target image doesn't exists at location "${hostappPath}"`);
			}
			test.comment(`Running: hostapp-update -f ${hostappPath}`);
			hupLog = await that.worker.executeCommandInHostOS(`hostapp-update -f ${hostappPath}`, target);

			await that.worker.executeCommandInHostOS(`rm ${hostappPath}`, target);

			await that.worker.executeCommandInHostOS(`umount /mnt/sysroot/inactive/balena/tmp`, target);
			break;

		case 'image':
			test.comment(`Running: hostapp-update -i ${hostapp}`);
			hupLog = await that.worker.executeCommandInHostOS(`hostapp-update -i ${hostapp}`, target);
			break;

		default:
			throw new Error(`Unsupported HUP mode: ${mode}`);
	}

	const hupLogPath = join(that.suite.options.tmpdir, `hup.log`);
	fs.writeFileSync(hupLogPath, hupLog);
	await that.archiver.add(that.id, hupLogPath);

	test.comment(`Finished HUP`);
};

const initDUT = async (that, test, target) => {
	test.comment(`Initializing DUT for HUP test`);

	if (supportsBootConfig(that.suite.deviceType.slug)) {
		await enableSerialConsole(that.os.image.path);
	}

	test.comment(`Flashing DUT`);
	await that.worker.off();
	await that.worker.flash(that.os.image.path);
	await that.worker.on();

	await that.worker.addSSHKey(that.sshKeyPath);

	// create tunnels
	console.log('Creating SSH tunnels to DUT');
	await that.worker.createSSHTunnels(
		that.link,
	);

	test.comment(`Waiting for DUT to be reachable`);
	await that.utils.waitUntil(async () => {
		return (
			(await that.worker.executeCommandInHostOS(
					'[[ -f /etc/hostname ]] && echo pass || echo fail',
					target,
				)) === 'pass'
		);
	}, true);
	test.comment(`DUT flashed`);

	// Retrieving journalctl logs
	that.teardown.register(async () => {
		await that.worker.archiveLogs(
				that.id,
				that.link,
				"journalctl --no-pager --no-hostname --list-boots | awk '{print $1}' | xargs -I{} sh -c 'set -x; journalctl --no-pager --no-hostname -a -b {} || true;'",
			);
	});
};

module.exports = {
	title: 'Hostapp update suite',

	run: async function () {
		const Worker = this.require('common/worker');
		const BalenaOS = this.require('components/os/balenaos');
		const Balena = this.require('components/balena/sdk');

		await fse.ensureDir(this.suite.options.tmpdir);

		this.suite.context.set({
			utils: this.require('common/utils'),
			sdk: new Balena(this.suite.options.balena.apiUrl, this.getLogger()),
			sshKeyPath: join(homedir(), 'id'),
			sshKeyLabel: this.suite.options.id,
			link: `${this.suite.options.balenaOS.config.uuid.slice(0, 7)}.local`,
			worker: new Worker(this.suite.deviceType.slug, 
				this.getLogger(), 
				this.suite.options.workerUrl, 
				this.suite.options.balena.organization, 
				join(homedir(), 'id')
			),
		});

		console.log(this.suite.options)

		// Network definitions
		if (this.suite.options.balenaOS.network.wired === true) {
			this.suite.options.balenaOS.network.wired = {
				nat: true,
			};
		} else {
			delete this.suite.options.balenaOS.network.wired;
		}
		if (this.suite.options.balenaOS.network.wireless === true) {
			this.suite.options.balenaOS.network.wireless = {
				ssid: this.suite.options.id,
				psk: `${this.suite.options.id}_psk`,
				nat: true,
			};
		} else {
			delete this.suite.options.balenaOS.network.wireless;
		}

		this.suite.context.set({
			hup: {
				checkUnderVoltage: checkUnderVoltage,
				doHUP: doHUP,
				initDUT: initDUT,
			},
		});

		// Downloads the balenaOS image we hup from
		let path = await this.sdk.fetchOS(
				this.suite.options.balenaOS.download.version,
				this.suite.deviceType.slug,
			);


		const keys = await this.utils.createSSHKey(this.sshKeyPath);
		this.log("Logging into balena with balenaSDK");
		await this.sdk.balena.auth.loginWithToken(this.suite.options.balena.apiKey);
		await this.sdk.balena.models.key.create(
			this.sshKeyLabel,
			keys.pubKey
		);
		this.suite.teardown.register(() => {
			return Promise.resolve(
				this.sdk.removeSSHKey(this.sshKeyLabel)
			);
		});


		this.suite.context.set({
			workerContract: await this.worker.getContract()
		})
		// if we are running qemu, and the device type is a flasher image, we need to unpack it from the flasher image to get it to boot
		if (
			this.suite.deviceType.data.storage.internal &&
			this.workerContract.workerType === `qemu`
		) {
			const RAW_IMAGE_PATH = `/opt/balena-image-${this.suite.deviceType.slug}.balenaos-img`;
			const OUTPUT_IMG_PATH = '/data/downloads/unwrapped.img';
			console.log(`Unwrapping flasher image ${path}`);
			await imagefs.interact(path, 2, async (fsImg) => {
				await pipeline(
					fsImg.createReadStream(RAW_IMAGE_PATH),
					fs.createWriteStream(OUTPUT_IMG_PATH),
				);
			});
			path = OUTPUT_IMG_PATH;
			console.log(`Unwrapped flasher image!`);
		}

		this.suite.context.set({
			os: new BalenaOS(
				{
					deviceType: this.suite.deviceType.slug,
					network: this.suite.options.balenaOS.network,
					image: `${path}`,
					configJson: {
						uuid: this.suite.options.balenaOS.config.uuid,
						os: {
							sshKeys: [
								keys.pubKey
							],
						},
						// persistentLogging is managed by the supervisor and only read at first boot
						persistentLogging: true,
						// Set local mode so we can perform local pushes of containers to the DUT
						localMode: true,
						developmentMode: true,
					},
				},
				this.getLogger(),
			),
			hupOs: new BalenaOS({}, this.getLogger()),
		});
		this.suite.teardown.register(() => {
			this.log('Worker teardown');
			return this.worker.teardown();
		});

		this.log('Setting up worker');
		await this.worker.network(this.suite.options.balenaOS.network);

		// Unpack both base and target OS images
		await this.os.fetch();
		await this.hupOs.fetch();
		// configure the image
		await this.os.configure();

		// Retrieving journalctl logs
		this.suite.teardown.register(async () => {
			await this.worker.archiveLogs(this.id, this.link);
		});
	},
	tests: [
		'./tests/smoke',
		'./tests/rollback-altboot',
		'./tests/rollback-health',
	],
};
