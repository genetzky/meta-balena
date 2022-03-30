/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

module.exports = {
	title: 'SSH authentication test',
	tests: [
		{
			title: 'SSH authentication in production mode',
			run: async function(test) {
				test.comment(`Waiting for os-config-json service to be inactive...`);
				return this.waitForServiceState(
						'os-config-json.service',
						'inactive',
						this.balena.uuid
				).then(() => {
					test.comment(`Setting production mode in config.json...`);
					return this.cloud.executeCommandInHostOS(
						[
							`tmp=$(mktemp)`,
							`&&`, `cat`,  `/mnt/boot/config.json`,
							`|`, `jq`, `'.developmentMode="false"'`,
							`>`, `$tmp`,
							`&&`, `mv`, `"$tmp"`, `/mnt/boot/config.json`,
						].join(' '),
						this.balena.uuid);
				}).then(() => {
					return this.waitForServiceState(
						'balena.service',
						'active',
						this.balena.uuid,
					)
				}).then(() => {
					return this.cloud.executeCommandInHostOS(
						`jq -r '.developmentMode' /mnt/boot/config.json`,
						this.balena.uuid
					)
				}).then((actual) => {
					const expected = 'false';
					test.equal(actual, expected, 'Device should be in production mode ');
				}).then(() => {
					return this.cloud.executeCommandInHostOS(
						[
							`tmp=$(mktemp)`, `&&`,
							`jq 'del(.os.sshKeys)'`, `/mnt/boot/config.json`,
							`>`,`$tmp`,`&&`, `mv`, `$tmp`,`/mnt/boot/config.json`
						].join(' '),
						this.balena.uuid
					)
				}).then(() => {
					return this.waitForServiceState(
						'openvpn.service',
						'active',
						this.balena.uuid,
					)
				}).then(() => {
					return this.cloud.executeCommandInHostOS(
						`jq -r '.os.sshKeys' /mnt/boot/config.json`,
						this.balena.uuid
					)
				}).then((actual) => {
					const expected = 'null';
					test.equal(actual, expected, 'No custom keys are present in config.json');
				}).then(() => {
					test.throws(
						this.worker.executeCommandInHostOS(
							'echo -n pass',
							`${this.balena.uuid.slice(0, 7)}.local`),
						{},
						"Local SSH authentication without custom keys is not allowed in production mode"
					)
				}).then(() => {
					return this.cloud.executeCommandInHostOS(
						['tmp=$(mktemp)', `&&`,
						`jq --arg keys '${this.keys.pubKey}' '. + {os: {sshKeys: [$keys]}}' "/mnt/boot/config.json" > $tmp`,
						`&&`, `mv "$tmp" /mnt/boot/config.json`
						].join(' '),
						this.balena.uuid)
				}).then(() => {
					return this.waitForServiceState(
						'openvpn.service',
						'active',
						this.balena.uuid,
					)
				}).then(async () => {
					test.equals(
						await this.worker.executeCommandInHostOS(
							'echo -n pass',
							`${this.balena.uuid.slice(0, 7)}.local`),
						"pass",
						"Local SSH authentication with custom keys is allowed in production mode"
					)
				}).then(() => {
					return this.cloud.executeCommandInHostOS(
						[
							`tmp=$(mktemp)`, `&&`,
							`jq 'del(.os.sshKeys)'`, `/mnt/boot/config.json`,
							`>`,`$tmp`, `&&`, `mv`, `$tmp`,`/mnt/boot/config.json`
						].join(' '),
						this.balena.uuid
					)
				});
			},
		},
		{
			title: 'SSH authentication in development mode',
			run: async function(test) {
				test.comment(`Waiting for os-config-json service to be inactive...`);
				return this.waitForServiceState(
					'os-config-json.service',
					'inactive',
					this.balena.uuid
				).then(() => {
					test.comment(`Setting development mode in config.json...`);
					return this.cloud.executeCommandInHostOS(
						[
							`tmp=$(mktemp)`,
							`&&`, `cat`,  `/mnt/boot/config.json`,
							`|`, `jq`, `'.developmentMode="true"'`,
							`>`, `$tmp`,
							`&&`, `mv`, `"$tmp"`, `/mnt/boot/config.json`,
						].join(' '),
						this.balena.uuid);
				}).then(() => {
					return this.waitForServiceState(
						'balena.service',
						'active',
						this.balena.uuid,
					)
				}).then(() => {
					return this.cloud.executeCommandInHostOS(
						`jq -r '.developmentMode' /mnt/boot/config.json`,
						this.balena.uuid
					)
				}).then((actual) => {
					const expected = 'true';
					test.equal(actual, expected, 'Device should be in development mode ');
				}).then(() => {
					return this.cloud.executeCommandInHostOS(
						[
							`tmp=$(mktemp)`, `&&`,
							`jq 'del(.os.sshKeys)'`, `/mnt/boot/config.json`,
							`>`,`$tmp`,`&&`, `mv`, `$tmp`,`/mnt/boot/config.json`
						].join(' '),
						this.balena.uuid
					)
				}).then(() => {
					return this.waitForServiceState(
						'openvpn.service',
						'active',
						this.balena.uuid,
					)
				}).then(() => {
					return this.cloud.executeCommandInHostOS(
						`jq -r '.os.sshKeys' /mnt/boot/config.json`,
						this.balena.uuid
					)
				}).then((actual) => {
					const expected = 'null';
					test.equal(actual, expected, 'No custom keys are present in config.json');
				}).then( async () => {
					test.equals(
						await this.worker.executeCommandInHostOS(
							'echo -n pass',
							`${this.balena.uuid.slice(0, 7)}.local`),
						"pass",
						"Local SSH authentication without custom keys is allowed in development mode"
					)
				}).then(() => {
					const Bluebird = require('bluebird');
					const keygen = Bluebird.promisify(require('ssh-keygen'));
					const phonyKey = keygen({
							location: this.sshKeyPath,
						}).then( () => {
							this.worker.executeCommandInHostOS(
								['tmp=$(mktemp)', `&&`,
									`jq --arg keys '${phonyKey}' '. + {os: {sshKeys: [$keys]}}' "/mnt/boot/config.json" > $tmp`,
									`&&`, `mv "$tmp" /mnt/boot/config.json`
								].join(' '),
								`${this.balena.uuid.slice(0, 7)}.local`)
						})
				}).then(() => {
					return this.waitForServiceState(
						'openvpn.service',
						'active',
						this.balena.uuid,
					)
				}).then(() => {
					test.throws(
						this.worker.executeCommandInHostOS(
							'echo -n pass',
							`${this.balena.uuid.slice(0, 7)}.local`),
						{},
						"Local SSH authentication with phony custom keys is not allowed in development mode"
					)
				}).then(() => {
					this.worker.executeCommandInHostOS(
						['tmp=$(mktemp)', `&&`,
							`jq --arg keys ${this.keys.pubKey} '. + {os: {sshKeys: [$keys]}}' "/mnt/boot/config.json" > $tmp`,
							`&&`, `mv "$tmp" /mnt/boot/config.json`
						].join(' '),
						`${this.balena.uuid.slice(0, 7)}.local`)
				}).then(() => {
					return this.waitForServiceState(
						'openvpn.service',
						'active',
						this.balena.uuid,
					)
				}).then(async () => {
					await test.equals(
						this.worker.executeCommandInHostOS(
							'echo -n pass',
							`${this.balena.uuid.slice(0, 7)}.local`),
						"pass",
						"Local SSH authentication with custom keys is allowed in development mode"
					)
				}).then(() => {
					return this.cloud.executeCommandInHostOS(
						[
							`tmp=$(mktemp)`, `&&`,
							`jq 'del(.os.sshKeys)'`, `/mnt/boot/config.json`,
							`>`,`$tmp`,`mv`, `$tmp`,`/mnt/boot/config.json`
						].join(' '),
						this.balena.uuid
					)
				});
			},
		},
	],
};
