import { Tab } from 'bootstrap';
import { ref } from 'tsx-vanilla';

import i18n from '../../../i18n/config';
import { IndividualSimUI } from '../../individual_sim_ui';
import { SimTab } from '../sim_tab';

export class UpgradesTab extends SimTab {
	readonly simUI: IndividualSimUI<any>;

	protected shoppingListElem: HTMLElement;

	constructor(parentElem: HTMLElement, simUI: IndividualSimUI<any>) {
		super(parentElem, simUI, { identifier: 'upgrades-tab', title: i18n.t('upgrades_tab.title') });

		this.simUI = simUI;

		const shoppingListBtnRef = ref<HTMLButtonElement>();
		const shoppingListRef = ref<HTMLDivElement>();

		this.contentContainer.appendChild(
			<>
				<div className="upgrades-tab-left tab-panel-left">
					<div className="upgrades-tab-tabs">
						<ul className="nav nav-tabs" attributes={{ role: 'tablist' }}>
							<li className="nav-item" attributes={{ role: 'presentation' }}>
								<button
									className="nav-link active"
									type="button"
									attributes={{
										role: 'tab',
										// @ts-expect-error
										'aria-controls': 'upgradesShoppingListTab',
										'aria-selected': true,
									}}
									dataset={{
										bsToggle: 'tab',
										bsTarget: `#upgradesShoppingListTab`,
									}}
									ref={shoppingListBtnRef}>
									{i18n.t('upgrades_tab.subtabs.shopping_list')}
								</button>
							</li>
						</ul>
						<div className="tab-content">
							<div id="upgradesShoppingListTab" className="tab-pane fade active show" ref={shoppingListRef} />
						</div>
					</div>
				</div>
			</>,
		);

		this.shoppingListElem = shoppingListRef.value!;

		new Tab(shoppingListBtnRef.value!);

		this.buildTabContent();
	}

	protected buildTabContent() {
		this.shoppingListElem.appendChild(<div className="d-flex align-items-center justify-content-center p-gap">{i18n.t('upgrades_tab.placeholder')}</div>);
	}
}
