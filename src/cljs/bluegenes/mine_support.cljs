(ns bluegenes.mine-support
  "Checks of a mine's model for features that query a fixed set of paths. One
  BlueGenes serves several mines whose models differ (WormMine has no
  Gene.alleles, FlyMine no Gene.phenotypeAnnotations), so a feature checks the
  paths it queries against the model of the mine it queries.

  The model of a mine is in the db under [:mines mine-kw :service :model] once
  the mine has been the current one. For the other mines `::fetch` loads it into
  [:mine-models mine-kw]. An unknown model never blocks a feature."
  (:require [re-frame.core :refer [reg-event-fx]]
            [clojure.string :as str]
            [imcljs.fetch :as fetch]
            [bluegenes.utils :as utils]))

(defn mine-classes
  "The model classes of a mine, or nil when its model is not loaded."
  [db mine-kw]
  (or (get-in db [:mines mine-kw :service :model :classes])
      (get-in db [:mine-models mine-kw :classes])))

(defn missing-paths
  "The entries of `paths` that do not resolve in `classes`, in order. Empty when
  the model is unknown (`classes` is nil)."
  [classes paths]
  (if (seq classes)
    (utils/unmet-depends classes paths)
    []))

(defn reason
  "Short sentence naming the missing paths, or nil when none is missing.
  `subject` is the mine's name."
  [subject missing]
  (when (seq missing)
    (str (or subject "This mine") " has no "
         (str/join ", " (take 2 missing))
         (when (> (count missing) 2)
           (str " and " (- (count missing) 2) " more")))))

(defn blocked-reason
  "Reason a feature that queries `paths` cannot run in a mine with model
  `classes`, or nil when it can run or the model is unknown."
  [classes subject paths]
  (reason subject (missing-paths classes paths)))

(reg-event-fx
 ::fetch
 ;; Loads the model of `mine-kw` unless it is known, then dispatches `next-event`
 ;; if given (also when the model could not be loaded, which leaves it unknown).
 (fn [{db :db} [_ mine-kw next-event]]
   (let [root (or (get-in db [:env :mines mine-kw :service :root])
                  (get-in db [:mines mine-kw :service :root]))]
     (if (or (some? (mine-classes db mine-kw)) (str/blank? root))
       (when next-event {:dispatch next-event})
       {:im-chan {:chan (fetch/model {:root root})
                  :on-success [::success mine-kw next-event]
                  :on-failure [::failure next-event]}}))))

(reg-event-fx
 ::success
 (fn [{db :db} [_ mine-kw next-event model]]
   (cond-> {:db (assoc-in db [:mine-models mine-kw] model)}
     next-event (assoc :dispatch next-event))))

(reg-event-fx
 ::failure
 (fn [_ [_ next-event _res]]
   (when next-event {:dispatch next-event})))
